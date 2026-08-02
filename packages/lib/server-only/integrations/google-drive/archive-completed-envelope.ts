import fs from 'node:fs/promises';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType } from '@prisma/client';

import { importPKCS8, SignJWT } from 'jose';
import { parseTeamOperationsSettings } from '../../../types/team-operations';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { env } from '../../../utils/env';

const DRIVE_API_URL = 'https://www.googleapis.com/drive/v3';

export const isCompletionArchiveProviderConfigured = () =>
  Boolean(
    env('NEXT_PRIVATE_GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE') || env('NEXT_PRIVATE_GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON'),
  );

const getAccessToken = async () => {
  const credentialsJson = env('NEXT_PRIVATE_GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON');
  const keyFile = env('NEXT_PRIVATE_GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE');
  const rawCredentials = credentialsJson || (keyFile ? await fs.readFile(keyFile, 'utf8') : null);

  if (!rawCredentials) {
    throw new Error('Google Drive service account credentials are not configured');
  }

  const credentials = JSON.parse(rawCredentials) as {
    client_email?: string;
    private_key?: string;
    token_uri?: string;
  };

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('Google Drive service account credentials are incomplete');
  }

  const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(credentials.private_key, 'RS256');
  // The archive destination is an existing folder shared with the service account.
  // `drive.file` only exposes files created or explicitly opened by this app, so it
  // cannot discover a folder that an administrator shares after deployment.
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/drive' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(credentials.client_email)
    .setSubject(credentials.client_email)
    .setAudience(tokenUri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const result = (await response.json()) as { access_token?: string; error_description?: string };
  const accessToken = result.access_token;

  if (!response.ok || !accessToken) {
    throw new Error(result.error_description || 'Google Drive authentication did not return an access token');
  }

  return accessToken;
};

const driveRequest = async <T>(accessToken: string, path: string, init?: RequestInit) => {
  const response = await fetch(`${DRIVE_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers || {}),
    },
  });
  const result = (await response.json()) as T & { error?: { message?: string } };

  if (!response.ok) {
    throw new Error(result.error?.message || `Google Drive returned HTTP ${response.status}`);
  }

  return result;
};

const findArchiveFolder = async (accessToken: string, rootFolderId: string, envelopeId: string) => {
  const query = `'${rootFolderId.replaceAll("'", "\\'")}' in parents and trashed = false and appProperties has { key='documensoEnvelopeId' and value='${envelopeId.replaceAll("'", "\\'")}' }`;
  const search = new URLSearchParams({ q: query, fields: 'files(id,name,webViewLink)', pageSize: '1' });
  const result = await driveRequest<{ files: Array<{ id: string; name: string; webViewLink?: string }> }>(
    accessToken,
    `/files?${search.toString()}`,
  );

  return result.files[0] ?? null;
};

const findChildByProperty = async ({
  accessToken,
  parentId,
  key,
  value,
}: {
  accessToken: string;
  parentId: string;
  key: string;
  value: string;
}) => {
  const escapeDriveQuery = (input: string) => input.replaceAll("'", "\\'");
  const query = `'${escapeDriveQuery(parentId)}' in parents and trashed = false and appProperties has { key='${escapeDriveQuery(key)}' and value='${escapeDriveQuery(value)}' }`;
  const search = new URLSearchParams({ q: query, fields: 'files(id,name,webViewLink)', pageSize: '1' });
  const result = await driveRequest<{ files: Array<{ id: string; name: string; webViewLink?: string }> }>(
    accessToken,
    `/files?${search.toString()}`,
  );

  return result.files[0] ?? null;
};

const createDriveFile = async ({
  accessToken,
  name,
  parentId,
  mimeType,
  data,
  appProperties,
}: {
  accessToken: string;
  name: string;
  parentId: string;
  mimeType: string;
  data?: Uint8Array;
  appProperties?: Record<string, string>;
}) => {
  const file = await driveRequest<{ id: string; webViewLink?: string }>(accessToken, '/files?fields=id,webViewLink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parentId], mimeType: data ? undefined : mimeType, appProperties }),
  });

  if (data) {
    const response = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media&fields=id,webViewLink`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': mimeType },
        body: Buffer.from(data),
      },
    );

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Google Drive upload failed (${response.status}): ${message.slice(0, 500)}`);
    }
  }

  return file;
};

const safeName = (value: string) =>
  value
    .replaceAll(/[\\/:*?"<>|]/g, '-')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 160);

export const archiveCompletedEnvelopeToGoogleDrive = async (envelopeId: string) => {
  const envelope = await prisma.envelope.findFirstOrThrow({
    where: { id: envelopeId, type: EnvelopeType.DOCUMENT, status: DocumentStatus.COMPLETED },
    select: {
      id: true,
      secondaryId: true,
      title: true,
      createdAt: true,
      completedAt: true,
      externalId: true,
      team: { select: { teamGlobalSettings: { select: { operationsSettings: true } } } },
      envelopeItems: { select: { id: true, title: true, order: true, documentData: true }, orderBy: { order: 'asc' } },
      recipients: {
        select: { id: true, name: true, email: true, role: true, sentAt: true, signedAt: true, signingStatus: true },
      },
      auditLogs: { select: { id: true, type: true, createdAt: true, name: true, email: true, data: true } },
    },
  });
  const settings = parseTeamOperationsSettings(envelope.team.teamGlobalSettings.operationsSettings);

  if (!settings.archiveEnabled || !settings.driveFolderId) {
    return { skipped: true as const, reason: 'Team archive is disabled or has no destination folder' };
  }

  if (!isCompletionArchiveProviderConfigured()) {
    throw new Error('Google Drive archive credentials are not configured');
  }

  const accessToken = await getAccessToken();
  const existingFolder = await findArchiveFolder(accessToken, settings.driveFolderId, envelope.id);
  const completedDate = (envelope.completedAt || new Date()).toISOString().slice(0, 10);
  const folder =
    existingFolder ||
    (await createDriveFile({
      accessToken,
      name: safeName(`${completedDate} - ${envelope.title} - ${envelope.secondaryId}`),
      parentId: settings.driveFolderId,
      mimeType: 'application/vnd.google-apps.folder',
      appProperties: { documensoEnvelopeId: envelope.id },
    }));

  const existingManifest = await findChildByProperty({
    accessToken,
    parentId: folder.id,
    key: 'documensoArchiveManifest',
    value: envelope.id,
  });

  if (existingManifest) {
    return { skipped: false as const, folderId: folder.id, webViewLink: folder.webViewLink ?? null };
  }

  for (const [index, item] of envelope.envelopeItems.entries()) {
    const existingItem = await findChildByProperty({
      accessToken,
      parentId: folder.id,
      key: 'documensoEnvelopeItemId',
      value: item.id,
    });

    if (!existingItem) {
      const pdf = await getFileServerSide(item.documentData);
      await createDriveFile({
        accessToken,
        name: safeName(`${String(index + 1).padStart(2, '0')} - ${item.title}.pdf`),
        parentId: folder.id,
        mimeType: 'application/pdf',
        data: pdf,
        appProperties: { documensoEnvelopeItemId: item.id },
      });
    }
  }

  const manifest = new TextEncoder().encode(
    JSON.stringify(
      {
        schemaVersion: 1,
        envelope: {
          id: envelope.id,
          secondaryId: envelope.secondaryId,
          externalId: envelope.externalId,
          title: envelope.title,
          createdAt: envelope.createdAt,
          completedAt: envelope.completedAt,
        },
        recipients: envelope.recipients,
        auditLog: envelope.auditLogs,
      },
      null,
      2,
    ),
  );
  await createDriveFile({
    accessToken,
    name: 'completion-manifest.json',
    parentId: folder.id,
    mimeType: 'application/json',
    data: manifest,
    appProperties: { documensoArchiveManifest: envelope.id },
  });

  return { skipped: false as const, folderId: folder.id, webViewLink: folder.webViewLink ?? null };
};
