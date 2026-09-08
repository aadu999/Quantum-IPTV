export default async function handler(req, res) {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing URL");

  const response = await fetch(targetUrl);
  const data = await response.text();

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", response.headers.get("content-type") || "text/plain");
  res.status(200).send(data);
}