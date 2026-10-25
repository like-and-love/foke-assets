/**
 * 飞拓 / Foke AI 网关 — Toonflow 媒体提供方
 *
 * 放到 data/providers/ 即可生效，不需要重新构建。
 * 也可以让网页用 toonflow://install?type=provider&url=... 安装（上限 2 MB）。
 *
 * 网关口径（实测，非官方文档）：
 *   GET  /v1/models                 列模型，带价格与各分辨率单价
 *   POST /v1/images/generations     文生图 / 图生图，同步返回 URL
 *   POST /v1/videos                 视频，异步返回 202 + job_id
 *   GET  /v1/videos/{job_id}        轮询任务
 *
 * 两个坑：
 *   1. model 必须传 id，传展示名会 403。
 *   2. 图生图的参考图**只收 HTTPS URL**，不收 data URL。
 *      上游从中国大陆抓图，海外图床一律 502。所以这里内置了
 *      GitHub 公开仓库 + jsdelivr 的上传通道。
 */
const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "飞拓 API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off", placeholder: "ftk_..." },
  },
  {
    type: "input",
    field: "baseUrl" as const,
    title: "请求地址",
    value: "https://ai.fanke2026.xyz",
    props: { placeholder: "https://ai.fanke2026.xyz" },
  },
  {
    type: "input",
    field: "githubToken" as const,
    title: "图床 Token（图生图必填）",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off", placeholder: "github_pat_... 或 ghp_..." },
  },
  {
    type: "input",
    field: "githubRepo" as const,
    title: "图床仓库",
    value: "",
    props: { placeholder: "用户名/foke-assets（必须是 public）" },
  },
] as const;

const version = "1.0.0";
const IMAGE_POLL_LIMIT_MS = 5 * 60_000;
const VIDEO_POLL_LIMIT_MS = 30 * 60_000;

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export default {
  id: "foke",
  label: "飞拓 Foke",
  icon: "",
  version,
  readme: `飞拓（Foke）聚合网关，提供图片与视频生成。图片 ¥0.03/张（1K/2K/4K 同价），视频按秒计费。
\n 图生图需要配置「图床 Token」和「图床仓库」——网关的参考图只收 HTTPS URL，
\n 且上游从中国大陆抓图，海外图床会被拒。本提供方用 GitHub 公开仓库 + jsdelivr 中转。`,
  rules,
  models: [
    // ── 图片 ──
    {
      id: "GPT-image-2.5",
      label: "GPT-image-2.5（推荐，¥0.03）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "4K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
    {
      id: "nano-banana-pro",
      label: "nano-banana-pro（¥0.20）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "4K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    },
    // ── 视频 ──
    {
      id: "MiniMax H3",
      label: "MiniMax H3（最便宜）",
      type: "video",
      mode: ["text", "singleImage", "startFrameOptional", ["imageReference:9"]],
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "768p", "1080p"] }],
    },
    {
      id: "Seedance 2.0 mini",
      label: "Seedance 2.0 mini",
      type: "video",
      mode: ["text", "singleImage", "startFrameOptional", ["imageReference:9"]],
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
    },
  ] satisfies ProviderModel[],

  // ─────────────────────── 图床（本地图 → 公网 HTTPS） ───────────────────────
  async uploadToBed(this: ProviderContext, input: MediaInput): Promise<string> {
    if (input.type === "url") return input.url;

    const token = (this.config.githubToken as string | undefined)?.trim();
    if (!token) throw new Error("图生图需要先在提供方设置里填「图床 Token」和「图床仓库」");

    const bytes = input.type === "binary" ? input.data : Uint8Array.from(atob(input.data.split(",").pop() ?? ""), (c) => c.charCodeAt(0));
    const mime = input.mimeType || "image/png";
    const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    let repo = (this.config.githubRepo as string | undefined)?.trim() ?? "";
    const gh = async (method: string, path: string, body?: unknown) => {
      const res = await this.tool.fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "toonflow-foke-provider",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };

    if (!repo) {
      const me = await gh("GET", "/user");
      if (!me.ok) throw new Error(`图床 Token 无效（HTTP ${me.status}）`);
      repo = `${me.data.login}/foke-assets`;
    }

    let info = await gh("GET", `/repos/${repo}`);
    if (info.status === 404) {
      const [, , nm] = repo.split("/");
      const made = await gh("POST", "/user/repos", { name: nm, private: false, auto_init: true, description: "toonflow 参考图托管" });
      if (!made.ok) throw new Error(`建图床仓库失败：${this.tool.errorMessage(made.data)}`);
      info = made;
      await new Promise((r) => setTimeout(r, 4000)); // 等初始提交落定
    } else if (!info.ok) {
      throw new Error(`图床仓库不可用（HTTP ${info.status}）：${this.tool.errorMessage(info.data)}`);
    }
    const branch = (info.data.default_branch as string) || "main";
    const remote = `foke-assets/${name}`;

    let base64: string;
    if (input.type === "binary") {
      base64 = Buffer.from(input.data).toString("base64");
    } else {
      base64 = input.data.includes(",") ? input.data.split(",")[1] : input.data;
    }
    const put = await gh("PUT", `/repos/${repo}/contents/${remote}`, {
      message: `chore: add ${name}`,
      content: base64,
      branch,
    });
    if (!put.ok) throw new Error(`上传图床失败：${this.tool.errorMessage(put.data)}`);

    const url = `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${remote}`;
    // jsdelivr 对新文件有缓存延迟，等它真能取到再交给网关
    for (let i = 0; i < 12; i++) {
      try {
        const probe = await this.tool.fetch(url, { method: "GET" });
        if (probe.ok) return url;
      } catch {
        /* 继续等 */
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`jsdelivr 取不到刚上传的图（仓库 ${repo} 是 public 吗？）：${url}`);
  },

  // ─────────────────────── 图片 ───────────────────────
  async generateImage(this: ProviderContext, request: ImageRequest): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("请填写飞拓 API Key");
    const baseUrl = ((this.config.baseUrl as string)?.trim() || "https://ai.fanke2026.xyz").replace(/\/$/, "");

    // 网关只认 id。这里把展示名解析成当前可用的最便宜渠道。
    const modelId = await this.resolveModel(baseUrl, apiKey, request.model, "image");

    const images: string[] = [];
    for (const img of request.images ?? []) images.push(await this.uploadToBed(img));

    const payload: Record<string, unknown> = { model: modelId, prompt: request.prompt };
    if (request.size) payload.quality = request.size;        // 1K / 2K / 4K
    if (request.ratio) payload.aspect_ratio = request.ratio;
    if (request.n && request.n > 1) payload.n = request.n;
    if (images.length) payload.images = images;

    const signal = AbortSignal.any([AbortSignal.timeout(IMAGE_POLL_LIMIT_MS), ...(this.signal ? [this.signal] : [])]);
    const res = await this.tool.fetch(`${baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as { data?: { url?: string }[] };
    if (!res.ok) throw new Error(`飞拓出图失败（HTTP ${res.status}）：${this.tool.errorMessage(data)}`);

    const urls = (data.data ?? []).map((d) => d.url).filter((u): u is string => Boolean(u));
    if (!urls.length) throw new Error("飞拓返回成功但没有图片地址");
    return urls.map((url) => ({ mediaType: "image" as const, type: "url" as const, url }));
  },

  // ─────────────────────── 视频 ───────────────────────
  async generateVideo(this: ProviderContext, request: VideoRequest): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("请填写飞拓 API Key");
    const baseUrl = ((this.config.baseUrl as string)?.trim() || "https://ai.fanke2026.xyz").replace(/\/$/, "");

    const images: string[] = [];
    for (const img of [request.firstFrame, request.lastFrame, ...(request.images ?? [])]) {
      if (img) images.push(await this.uploadToBed(img));
    }

    const signal = AbortSignal.any([AbortSignal.timeout(VIDEO_POLL_LIMIT_MS), ...(this.signal ? [this.signal] : [])]);
    const candidates = await this.modelCandidates(baseUrl, apiKey, request.model, "video");

    let lastError = "";
    for (const modelId of candidates) {
      const payload: Record<string, unknown> = { model: modelId, prompt: request.prompt };
      if (request.duration) payload.duration = request.duration;
      if (request.resolution) payload.resolution = request.resolution;
      if (request.ratio) payload.aspect_ratio = request.ratio;
      if (images.length) payload.images = images;

      const res = await this.tool.fetch(`${baseUrl}/v1/videos`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      const submit = (await res.json().catch(() => ({}))) as { job_id?: string; id?: string; poll_after_seconds?: number };
      if (!res.ok) {
        lastError = this.tool.errorMessage(submit);
        // 「预扣费额度失败」= 这个渠道挂了，换下一个同价位渠道
        if (/预扣费|额度|后端|渠道/.test(lastError)) continue;
        throw new Error(`飞拓提交视频失败（HTTP ${res.status}）：${lastError}`);
      }
      const jobId = submit.job_id ?? submit.id;
      if (!jobId) throw new Error("飞拓提交视频未返回任务 ID");

      const interval = (submit.poll_after_seconds ?? 30) * 1000;
      while (true) {
        await wait(signal, interval);
        // 注意：响应里的 status_url 指向 localhost:9302（他们的 bug），必须自己拼公网地址
        const q = await this.tool.fetch(`${baseUrl}/v1/videos/${jobId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        });
        const st = (await q.json().catch(() => ({}))) as { status?: string; video_url?: string; url?: string };
        if (st.status === "completed" || st.status === "succeeded") {
          const url = st.video_url ?? st.url;
          if (!url) throw new Error("飞拓视频完成但没有地址");
          return [{ mediaType: "video" as const, type: "url" as const, url }];
        }
        if (st.status === "failed" || st.status === "error") throw new Error(`飞拓视频生成失败：${this.tool.errorMessage(st)}`);
      }
    }
    throw new Error(`飞拓所有候选渠道都失败了：${lastError}`);
  },

  // ─────────────────────── 内部：模型解析 ───────────────────────
  async modelCandidates(this: ProviderContext, baseUrl: string, apiKey: string, name: string, type: string): Promise<string[]> {
    if (name.startsWith("ft-")) return [name];
    const res = await this.tool.fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`拉取飞拓模型列表失败（HTTP ${res.status}）`);
    const data = (await res.json()) as { data?: Record<string, unknown>[] };
    const pool = (data.data ?? []).filter((m) => m.type === type);

    const priceOf = (m: Record<string, unknown>) => {
      const rp = (m.resolution_prices ?? {}) as Record<string, { amount?: number }>;
      const vals = Object.values(rp).map((v) => v.amount ?? 9e9);
      const p = (m.price ?? {}) as { amount?: number };
      return Math.min(...(vals.length ? vals : [p.amount ?? 9e9]));
    };

    let hits = pool.filter((m) => m.name === name);
    if (!hits.length) hits = pool.filter((m) => String(m.name ?? "").includes(name));
    if (!hits.length) throw new Error(`飞拓找不到模型「${name}」`);
    // 同名多渠道：按价格升序，坏的排后面（靠 generateVideo 的失败重试兜底）
    return hits.sort((a, b) => priceOf(a) - priceOf(b)).map((m) => String(m.id));
  },

  async resolveModel(this: ProviderContext, baseUrl: string, apiKey: string, name: string, type: string): Promise<string> {
    const list = await this.modelCandidates(baseUrl, apiKey, name, type);
    return list[0];
  },
} satisfies ProviderDefinition<typeof rules>;
