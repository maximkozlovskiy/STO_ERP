import { apiFetch } from './api';
import { getToken } from './auth';
import { Platform } from 'react-native';

const BASE_URL = Platform.select({
  android: 'http://10.0.2.2:3000/api',
  default: 'http://localhost:3000/api',
});

export interface UploadedPhoto {
  fileId: string;
  url: string;
  filename: string;
}

export async function uploadWorkOrderPhoto(
  workOrderId: string,
  uri: string,
  filename: string,
): Promise<UploadedPhoto> {
  const token = getToken();
  const formData = new FormData();
  formData.append('file', {
    uri,
    name: filename,
    type: 'image/jpeg',
  } as unknown as Blob);
  formData.append('workOrderId', workOrderId);

  const res = await fetch(`${BASE_URL}/files/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ?? `HTTP ${res.status}`);
  }

  return res.json();
}
