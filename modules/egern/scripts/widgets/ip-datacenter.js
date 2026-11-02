// =========================
// 环境变量策略组
// 名称：POLICY
// 值：你的策略组名字 (Egern会传进来)
// =========================
export default async function(ctx) {
  const policy = ctx.env.POLICY || "";
  const widgetFamily = ctx.widgetFamily || "systemMedium";
  const BG_COLOR = { light: "#FFFFFF", dark: "#1C1C1E" };
  const C_TITLE = { light: "#1A1A1A", dark: "#FFD700" };
  const C_SUB = { light: "#666666", dark: "#B0B0B0" };
  const C_MAIN = { light: "#1A1A1A", dark: "#FFFFFF" };
  const C_GREEN = { light: "#32D74B", dark: "#32D74B" };
  const C_YELLOW = { light: "#FFD60A", dark: "#FFD60A" };
  const C_ORANGE = { light: "#FF9500", dark: "#FF9500" };
  const C_RED = { light: "#FF3B30", dark: "#FF3B30" };
  const C_ICON = { light: "#007AFF", dark: "#0A84FF" };

  if (widgetFamily === "systemSmall" || widgetFamily.includes("accessory")) {
    return {
      type: "widget",
      padding: 16,
      backgroundColor: BG_COLOR,
      children: [
        { type: "text", text: "请使用中号或大号组件", font: { size: "callout" }, textColor: C_MAIN, textAlign: "center" }
      ]
    };
  }

  const BASE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

  function withPolicy(opts) {
    const options = opts || {};
    if (policy && policy !== "DIRECT") {
      options.policy = policy;
    }
    return options;
  }

  async function getRaw(url, headers, extraOpts) {
    const opts = withPolicy({ timeout: 5000 });
    if (headers) opts.headers = headers;
    if (extraOpts) Object.assign(opts, extraOpts);
    return await ctx.http.get(url, opts);
  }

  async function get(url, headers) {
    const res = await getRaw(url, headers);
    return await res.text();
  }

  async function post(url, body, headers) {
    const opts = withPolicy({ timeout: 5000, body: body });
    if (headers) opts.headers = headers;
    const res = await ctx.http.post(url, opts);
    return await res.text();
  }

  function jp(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function ti(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  async function checkChatGPT() {
    try {
      const headRes = await getRaw("https://chatgpt.com", { "User-Agent": BASE_UA }, { redirect: "manual" });
      const webAccessible = !!headRes;
      const iosRes = await getRaw("https://ios.chat.openai.com", { "User-Agent": BASE_UA });
      const iosBody = iosRes ? await iosRes.text() : "";
      let cfDetails = "";
      try { cfDetails = jp(iosBody)?.cf_details || ""; } catch (e2) {}
      const appBlocked = !iosBody || iosBody.includes("blocked_why_headline") || iosBody.includes("unsupported_country_region_territory") || cfDetails.includes("(1)") || cfDetails.includes("(2)");
      const appAccessible = !!iosBody && !appBlocked;
      if (!webAccessible && !appAccessible) return "Cross";
      if (appAccessible && !webAccessible) return "APP";
      if (webAccessible && appAccessible) {
        const traceTxt = await get("https://chatgpt.com/cdn-cgi/trace");
        const tm = traceTxt ? traceTxt.match(/loc=([A-Z]{2})/) : null;
        if (tm && tm[1]) return tm[1];
        return "OK";
      }
      return "Cross";
    } catch (e) { return "Cross"; }
  }

  async function checkGemini() {
    try {
      const bodyRaw = 'f.req=[["K4WWud","[[0],[\\"en-US\\"]]",null,"generic"]]';
      const txt = await post("https://gemini.google.com/_/BardChatUi/data/batchexecute", bodyRaw, { "User-Agent": BASE_UA, "Accept-Language": "en-US", "Content-Type": "application/x-www-form-urlencoded" });
      if (!txt) return "Cross";
      let m = txt.match(new RegExp('"countryCode"\\s*:\\s*"([A-Z]{2})"'));
      if (m && m[1]) return m[1].toUpperCase();
      return "OK";
    } catch (e) { return "Cross"; }
  }

  async function checkClaude() {
    try {
      const res = await getRaw("https://claude.ai/login", { "User-Agent": BASE_UA });
      if (!res || res.status === 403) return "Cross";
      const body = await res.text();
      if (body.includes("App unavailable") || body.includes("unsupported_country")) return "Cross";
      return "OK";
    } catch (e) { return "Cross"; }
  }

  async function checkYouTube() {
    try {
      const body = await get("https://www.youtube.com/premium", { "User-Agent": BASE_UA, "Accept-Language": "en" });
      if (!body) return "Cross";
      if (body.includes("www.google.cn")) return "CN";
      const isNotAvailable = body.includes("Premium is not available in your country") || body.includes("YouTube Premium is not available");
      const m = body.match(new RegExp('"contentRegion"\\s*:\\s*"?([A-Z]{2})"?'));
      const region = m && m[1] ? m[1].toUpperCase() : null;
      const isAvailable = body.includes("ad-free") || body.includes("Ad-free");
      if (isNotAvailable) return "Cross";
      if (isAvailable && region) return region;
      if (isAvailable && !region) return "OK";
      if (region) return region;
      return "Cross";
    } catch (e) { return "Cross"; }
  }

  async function checkNetflix() {
    try {
      const titles = [ "https://www.netflix.com/title/81280792", "https://www.netflix.com/title/70143836" ];
      const fetchTitle = async (url) => { try { return await get(url, { "User-Agent": BASE_UA }); } catch (e) { return ""; } };
      const bodies = await Promise.all([ fetchTitle(titles[0]), fetchTitle(titles[1]) ]);
      const t1 = bodies[0]; const t2 = bodies[1];
      if (!t1 && !t2) return "Cross";
      if (t1.includes("oh no!") && t2.includes("oh no!")) return "Popcorn";
      for (const b of [t1, t2]) {
        if (!b) continue;
        const rm = b.match(new RegExp('"countryCode"\\s*:\\s*"?([A-Z]{2})"?'));
        if (rm && rm[1]) return rm[1];
      }
      return "OK";
    } catch (e) { return "Cross"; }
  }

  async function checkTikTok() {
    try {
      let body1 = await get("https://www.tiktok.com/", { "User-Agent": BASE_UA });
      if (body1 && body1.includes("Please wait...")) {
        try { body1 = await get("https://www.tiktok.com/explore", { "User-Agent": BASE_UA }); } catch (e2) {}
      }
      const reg = new RegExp('"region"\\s*:\\s*"([A-Z]{2})"');
      let m1 = body1 ? body1.match(reg) : null;
      if (m1 && m1[1]) return m1[1];
      const body2 = await get("https://www.tiktok.com/", { "User-Agent": BASE_UA, "Accept-Language": "en" });
      const m2 = body2 ? body2.match(reg) : null;
      if (m2 && m2[1]) return m2[1];
      if (body1 || body2) return "OK";
      return "Cross";
    } catch (e) { return "Cross"; }
  }

  async function checkTG() {
    try {
      const res = await getRaw("https://core.telegram.org", null, { timeout: 3000 });
      if (res && res.status === 200) return { status: "大概率正常", col: C_GREEN };
      return { status: "可能受限", col: C_ORANGE };
    } catch(e) { return { status: "大概率正常", col: C_GREEN }; }
  }

  async function checkProxy(ip) {
    try {
      if (!ip || ip === "获取失败") return { status: "未知", col: C_SUB, riskScore: 0 };
      const res = await getRaw(`http://proxycheck.io/v2/${ip}?vpn=1&asn=1`, null, { timeout: 3000 });
      const j = JSON.parse(await res.text());
      const node = j[ip];
      if (node) {
        let type = node.type || "Unknown";
        if (type.length > 8) type = type.substring(0,8) + ".";
        const risk = node.risk || 0;
        return { status: `${type}/${risk}`, col: risk < 33 ? C_GREEN : C_ORANGE, riskScore: risk };
      }
      return { status: "正常", col: C_GREEN, riskScore: 0 };
    } catch(e) { return { status: "获取失败", col: C_SUB, riskScore: 0 }; }
  }

  async function checkBlackbox(ip) {
    try {
      if (!ip || ip === "获取失败") return { status: "未知", col: C_SUB, riskScore: 0 };
      const res = await getRaw(`https://blackbox.ipinfo.app/lookup/${ip}`, null, { timeout: 3000 });
      const txt = (await res.text()).trim();
      if (txt === "N") return { status: "正常", col: C_GREEN, riskScore: 0 };
      if (txt === "Y") return { status: "异常", col: C_RED, riskScore: 30 };
      return { status: "未知", col: C_SUB, riskScore: 0 };
    } catch(e) { return { status: "获取失败", col: C_SUB, riskScore: 0 }; }
  }

  async function checkIpapi(ip) {
    try {
      if (!ip || ip === "获取失败") return { status: "未知", col: C_SUB, riskScore: 0 };
      const res = await getRaw(`https://api.ipapi.is/?q=${ip}`, null, { timeout: 4000 });
      const j = JSON.parse(await res.text());
      let pct = 0;
      if (j.company && j.company.abuser_score) {
        const m = String(j.company.abuser_score).match(new RegExp("([0-9.]+)"));
        if (m) pct = Number(m[1]) * 100;
      }
      let val = pct.toFixed(2) + "%";
      if (val === "0.00%") val = "0.01%";
      return { status: val, col: pct > 5 ? C_RED : (pct > 1 ? C_ORANGE : C_GREEN), riskScore: pct };
    } catch(e) { return { status: "获取失败", col: C_SUB, riskScore: 0 }; }
  }

  async function checkNetCoffee(ip) {
    try {
      if (!ip || ip === "获取失败") return { status: "未知", col: C_SUB };
      const res = await getRaw(`https://ip.net.coffee/api/ip/`, null, { timeout: 3000 });
      const j = JSON.parse(await res.text());
      if (j && j.trust !== undefined) return { status: `信任 ${j.trust}`, col: j.trust >= 80 ? C_GREEN : C_ORANGE };
      return { status: "信任 100", col: C_GREEN };
    } catch(e) { return { status: "信任 100", col: C_GREEN }; }
  }

  const fmtISP = (isp) => {
    if (!isp) return "未知";
    const s = String(isp).toLowerCase();
    if (s.includes("移动") || s.includes("mobile") || s.includes("cmcc")) return "中国移动";
    if (s.includes("电信") || s.includes("telecom") || s.includes("chinanet")) return "中国电信";
    if (s.includes("联通") || s.includes("unicom")) return "中国联通";
    if (s.includes("广电") || s.includes("broadcast") || s.includes("cbn")) return "中国广电";
    return isp;
  };

  const getFlagEmoji = (country) => {
    if (!country) return "🌐";
    if (country.includes("中国")) return "🇨🇳";
    if (country.includes("日本")) return "🇯🇵";
    if (country.includes("美国")) return "🇺🇸";
    if (country.includes("香港")) return "🇭🇰";
    if (country.includes("台湾")) return "🇹🇼";
    if (country.includes("新加坡")) return "🇸🇬";
    if (country.includes("英国")) return "🇬🇧";
    return "📍";
  };

  let lIp = "获取失败", lLoc = "未知位置", lIsp = "未知运营商";
  let nIp = "获取失败", nLoc = "未知位置", nativeText = "未知";
  let ippureData = { status: "未知", col: C_SUB, riskScore: 0 };

  await Promise.all([
    (async () => {
      try {
        const lRes = await ctx.http.get("https://myip.ipip.net/json", { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 3000, policy: "DIRECT" });
        const body = JSON.parse(await lRes.text());
        if (body?.data) {
          lIp = body.data.ip || "获取失败";
          const locArr = body.data.location || [];
          lLoc = `${getFlagEmoji(locArr[0])} ${locArr[1] || ""} ${locArr[2] || ""}`.trim();
          lIsp = fmtISP(locArr[4] || locArr[3]);
        }
      } catch (e) {}
    })(),
    (async () => {
      try {
        const res = await ctx.http.get("https://my.ippure.com/v1/info", withPolicy({ timeout: 4000 }));
        if (res && res.status === 200) {
          const d = JSON.parse(await res.text());
          nIp = d.ip || "获取失败";
          let code = d.countryCode || "";
          if (code.toUpperCase() === "TW") code = "CN";
          const flag = code ? String.fromCodePoint(...code.toUpperCase().split("").map(c => 127397 + c.charCodeAt())) : "🌍";
          nLoc = `${flag} ${d.country || ""} ${d.city || ""}`.trim() || "未知位置";
          nativeText = d.isResidential === true ? "🏠 住宅宽带" : d.isResidential === false ? "🏢 商业机房" : "未知";
          
          const risk = ti(d.fraudScore);
          if (risk !== null) {
            let col = C_GREEN;
            if (risk > 60) col = C_RED;
            else if (risk > 0) col = C_ORANGE;
            ippureData = { status: risk === 0 ? "纯净" : `风险 ${risk}`, col: col, riskScore: risk };
          }
        }
      } catch (e) {}
    })()
  ]);

  const proxySuccess = nIp !== "获取失败";

  let gptStatus="Cross", geminiStatus="Cross", claudeStatus="Cross", youtubeStatus="Cross", netflixStatus="Cross", tiktokStatus="Cross";
  let tgData={status:"未知",col:C_SUB}, ipapiData={status:"未知",col:C_SUB}, proxyData={status:"未知",col:C_SUB}, blackboxData={status:"未知",col:C_SUB}, netCoffeeData={status:"未知",col:C_SUB};

  if (proxySuccess) {
    [
      gptStatus, geminiStatus, claudeStatus, youtubeStatus, netflixStatus, tiktokStatus,
      tgData, ipapiData, proxyData, blackboxData, netCoffeeData
    ] = await Promise.all([
      checkChatGPT(), checkGemini(), checkClaude(), checkYouTube(), checkNetflix(), checkTikTok(),
      checkTG(), checkIpapi(nIp), checkProxy(nIp), checkBlackbox(nIp), checkNetCoffee(nIp)
    ]);
  }

  const totalRiskScore = Math.round((ippureData.riskScore || 0) + (ipapiData.riskScore || 0) + (proxyData.riskScore || 0));
  const topRiskTxt = `风险 ${totalRiskScore}`;
  const topRiskCol = totalRiskScore === 0 ? C_GREEN : (totalRiskScore > 30 ? C_RED : C_ORANGE);
  const topRiskIcon = totalRiskScore === 0 ? "checkmark.shield.fill" : "exclamationmark.shield.fill";

  const SMALL_FONT = 9.5;
  const SMALL_ICON = 11;

  function smallInfoRow(iconName, label, value, valueCol) {
    const finalCol = valueCol || C_MAIN;
    return {
      type: "stack", direction: "row", alignItems: "center", gap: 5,
      children: [
        { type: "image", src: `sf-symbol:${iconName}`, color: C_ICON, width: SMALL_ICON, height: SMALL_ICON },
        { type: "text", text: label, font: { size: SMALL_FONT }, textColor: C_SUB },
        { type: "spacer" },
        { type: "text", text: value, font: { size: SMALL_FONT, weight: "bold" }, textColor: finalCol, maxLines: 1 }
      ]
    };
  }

  function ItemRow(name, status, color, iconName, iconColor) {
    return {
      type: "stack", direction: "row", alignItems: "center", gap: 4,
      children: [
        { type: "image", src: `sf-symbol:${iconName}`, color: iconColor, width: SMALL_ICON, height: SMALL_ICON },
        { type: "text", text: name, font: { size: SMALL_FONT, weight: "medium" }, textColor: C_MAIN },
        { type: "spacer" },
        { type: "text", text: status, font: { size: SMALL_FONT, weight: "bold" }, textColor: color, maxLines: 1 }
      ]
    };
  }

  function UnlockRow(name, status) {
    let icon = "checkmark.circle.fill";
    let col = C_GREEN;
    let text = status === "OK" ? "OK" : status;
    if (status === "Cross") { icon = "xmark.circle.fill"; col = C_RED; text = "不可用"; }
    else if (status === "CN") { icon = "xmark.circle.fill"; col = C_RED; text = "送中"; }
    else if (status === "Popcorn") { text = "仅自制"; }
    return ItemRow(name, text, col, icon, col);
  }

  function RiskRow(name, data) {
    let icon = "checkmark.circle.fill";
    if (data.col === C_RED) icon = "xmark.circle.fill";
    else if (data.col === C_ORANGE || data.col === C_YELLOW) icon = "exclamationmark.circle.fill";
    else if (data.col === C_SUB) icon = "questionmark.circle.fill";
    return ItemRow(name, data.status, data.col, icon, data.col);
  }

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const isLarge = widgetFamily === "systemLarge";
  const WIDGET_PADDING = isLarge ? [10, 12] : [8, 10];
  const COL_GAP = 12;

  return {
    type: "widget",
    padding: WIDGET_PADDING,
    gap: 3,
    backgroundColor: BG_COLOR,
    children: [
      {
        type: "stack", direction: "row", alignItems: "center", gap: 6,
        children: [
          { type: "text", text: "数据中心 (DCH)", font: { size: 13, weight: "heavy" }, textColor: C_TITLE },
          {
            type: "stack", direction: "row", alignItems: "center", gap: 2,
            children: [
              { type: "image", src: `sf-symbol:${topRiskIcon}`, color: topRiskCol, width: 12, height: 12 },
              { type: "text", text: topRiskTxt, font: { size: 11, weight: "bold" }, textColor: topRiskCol }
            ]
          },
          { type: "spacer" },
          {
            type: "stack", direction: "row", alignItems: "center", gap: 2,
            children: [
              { type: "image", src: "sf-symbol:exclamationmark.circle.fill", color: C_ORANGE, width: 12, height: 12 },
              { type: "text", text: policy || "默认节点", font: { size: 11, weight: "bold" }, textColor: C_ORANGE, maxLines: 1 }
            ]
          },
          { type: "spacer" },
          {
            type: "stack", direction: "row", alignItems: "center", gap: 2,
            children: [
              { type: "image", src: "sf-symbol:arrow.clockwise", color: C_SUB, width: 11, height: 11 },
              { type: "text", text: timeStr, font: { size: 11 }, textColor: C_SUB }
            ]
          }
        ]
      },
      {
        type: "stack", direction: "row", gap: COL_GAP,
        children: [
          {
            type: "stack", direction: "column", gap: 2.5, flex: 1,
            children: [
              smallInfoRow("house.fill", "本地IP:", lIp, C_GREEN),
              smallInfoRow("person.fill", "本地位置:", lLoc),
              smallInfoRow("simcard.fill", "本地运营商:", lIsp)
            ]
          },
          {
            type: "stack", direction: "column", gap: 2.5, flex: 1,
            children: [
              smallInfoRow("globe", "落地IP:", nIp, proxySuccess ? C_GREEN : C_RED),
              smallInfoRow("map.fill", "落地位置:", nLoc, proxySuccess ? C_MAIN : C_RED),
              smallInfoRow("building.2.fill", "原生属性:", nativeText, proxySuccess ? C_MAIN : C_RED)
            ]
          }
        ]
      },
      { type: "stack", height: 0.5, backgroundColor: { light: "rgba(0,0,0,0.08)", dark: "rgba(255,255,255,0.12)" } },
      {
        type: "stack", direction: "row", gap: COL_GAP,
        children: [
          {
            type: "stack", direction: "column", gap: 2, flex: 1,
            children: [
              UnlockRow("GPT", gptStatus),
              UnlockRow("Claude", claudeStatus),
              UnlockRow("Gemini", geminiStatus),
              UnlockRow("YouTube", youtubeStatus),
              UnlockRow("奈飞", netflixStatus),
              UnlockRow("TikTok", tiktokStatus)
            ]
          },
          {
            type: "stack", direction: "column", gap: 2, flex: 1,
            children: [
              RiskRow("TG 预测", tgData),
              RiskRow("IPPure", ippureData),
              RiskRow("ipapi", ipapiData),
              RiskRow("NetCoffee", netCoffeeData),
              RiskRow("Proxy...", proxyData),
              RiskRow("Blackbox", blackboxData)
            ]
          }
        ]
      }
    ]
  };
}
