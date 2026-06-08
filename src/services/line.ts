// LINE Messaging API ラッパー

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';

interface LineUserProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
}

export async function getLineUserProfile(userId: string): Promise<LineUserProfile> {
  const url = `https://api.line.biz/v2/bot/profile/${userId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Failed to get LINE user profile: ${res.status}`);

  const json = await res.json();
  return {
    userId: json.userId,
    displayName: json.displayName,
    pictureUrl: json.pictureUrl,
    statusMessage: json.statusMessage,
  };
}

export async function fetchLineMessageContent(messageId: string): Promise<Buffer> {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch LINE message content: ${res.status}`);

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function sendLineMessage(userId: string, text: string): Promise<void> {
  const url = `https://api.line.biz/v2/bot/message/push`;
  const payload = {
    to: userId,
    messages: [{ type: 'text', text }],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Failed to send LINE message: ${res.status}`);
}

export function getLineContentType(res: Response): string {
  return res.headers.get('content-type') || 'application/octet-stream';
}
