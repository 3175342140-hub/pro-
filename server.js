import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
// 直接对接你的 Cloudflare Worker 专属地址，本地完全不需要存 API Key
const CF_WORKER_URL = "https://emotion-api.3175342140.workers.dev";

app.post("/api/analyze", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "未接收到音频数据" });
    }

    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || "audio/webm" });
    formData.append("audio", blob, "sample.webm");
    formData.append("metrics", req.body.metrics || "{}");

    const cfRes = await fetch(CF_WORKER_URL, {
      method: "POST",
      body: formData
    });

    const data = await cfRes.json();
    return res.status(cfRes.status).json(data);
  } catch (error) {
    console.error("[Proxy Error]:", error);
    return res.status(500).json({
      ok: false,
      error: "连接 Cloudflare 评估节点失败：" + (error.message || "网络异常")
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ 魂芳志启已启动（已对接 Cloudflare 安全网关）：http://localhost:${PORT}`);
});