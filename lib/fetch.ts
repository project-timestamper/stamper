export const PAGES_BASE = "https://project-timestamper.github.io/timestamper";

export const download = async (url: string): Promise<Buffer> => {
  const response = await fetch(url, {
    headers: { "user-agent": "stamper/0.1 (Project Timestamper verifier)" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `download failed: ${response.status} ${response.statusText} (${url})`
    );
  }
  return Buffer.from(await response.arrayBuffer());
};
