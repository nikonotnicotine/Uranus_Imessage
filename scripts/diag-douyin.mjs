/**
 * 抖音分享链接探测：给一条链接，把能拿到的东西全打出来。
 *
 * 用法：node scripts/diag-douyin.mjs 'https://v.douyin.com/xxxx/'
 *
 * 这个脚本只用来验「抖音那条路还通不通」—— 人家改版之后第一件事就是跑它，
 * 比在 linkmeta.js 里加日志快得多。
 */
const MUA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const raw = process.argv[2];
if (!raw) {
  console.error("用法: node scripts/diag-douyin.mjs <抖音链接>");
  process.exit(1);
}

const H = { "User-Agent": MUA, "Accept-Language": "zh-CN,zh;q=0.9" };

/*
 * 要请求两次。
 *
 * 桌面 UA 一律返回 2.4KB 空壳；手机 UA 不带 cookie 只有 33KB 的渲染上下文
 * （videoInfoRes 是 null）。ttwid 是 `.iesdouyin.com` 在**第一次访问分享页**时
 * 下发的，所以第一趟纯粹是去收这个 cookie，第二趟带上它才拿到完整 SSR 数据。
 */
const first = await fetch(raw, { headers: H, redirect: "follow" });
const ttwid = (first.headers.getSetCookie?.() ?? [])
  .map((c) => /ttwid=([^;]+)/.exec(c)?.[1])
  .find(Boolean);
console.log("ttwid:", ttwid ? `${ttwid.slice(0, 24)}…` : "(没拿到)");
// 正文只能读一次，所以先存下来 —— 拿不到 ttwid 时下面要复用这一份
const firstHtml = await first.text();
console.log("第一趟大小:", Math.round(firstHtml.length / 1024), "KB");

let html = firstHtml;
let finalUrl = first.url;
if (ttwid) {
  const second = await fetch(first.url, {
    headers: { ...H, Cookie: `ttwid=${ttwid}` },
    redirect: "follow",
  });
  html = await second.text();
  finalUrl = second.url;
}
console.log("最终地址:", finalUrl.slice(0, 80));
console.log("页面大小:", Math.round(html.length / 1024), "KB");

const m = /_ROUTER_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(html);
if (!m) {
  console.log("没找到 _ROUTER_DATA —— 这条路断了");
  process.exit(0);
}
const data = JSON.parse(m[1]);
const page = Object.entries(data.loaderData ?? {}).find(([k]) => k.includes("/page"))?.[1];
const item = page?.videoInfoRes?.item_list?.[0];
if (!item) {
  console.log("有 _ROUTER_DATA 但没有 item_list（cookie 没生效？）");
  console.log("page keys:", Object.keys(page ?? {}).join(", "));
  process.exit(0);
}

console.log("--- aweme_type:", item.aweme_type, "(2/68=图文, 其他=视频)");
console.log("--- 作者:", item.author?.nickname);
console.log("--- 配文:", item.desc);
console.log("--- 配乐:", item.music?.title, "| 作者:", item.music?.author);
console.log("--- 图片:", item.images?.length ?? 0, "张");
console.log("--- 视频封面:", item.video?.cover?.url_list?.[0]?.slice(0, 90));
console.log("--- 时长:", item.video?.duration ?? item.duration);
