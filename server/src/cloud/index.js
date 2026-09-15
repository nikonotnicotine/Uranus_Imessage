/**
 * 两家云的分发口。上层（index.js 的路由、maintenance.js 的定时器）只跟这个
 * 文件说话，不认识 s3 / github 的任何细节。
 *
 * 加第三家的话只要在这儿多一行 —— 上层一个字都不用改。
 */

import * as github from "./github.js";
import * as s3 from "./s3.js";

/** 界面上那两个按钮。`label` 是给人看的，`id` 会落进配置，别改。 */
export const PROVIDERS = [
  { id: "s3", label: "缤纷云", driver: s3 },
  { id: "github", label: "GitHub", driver: github },
];

/**
 * 按 id 取驱动和它那一份配置。
 *
 * 认不出的 provider 退回缤纷云而不是抛错 —— 配置里可能是手改坏的，或者是
 * 更新版本写下的值。退回去至少界面还能用，用户再选一次就好。
 */
export function driverFor(cloudBackup) {
  const id = String(cloudBackup?.provider ?? "").trim();
  const found = PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
  return {
    id: found.id,
    label: found.label,
    driver: found.driver,
    // 每家自己那一块配置（`cloudBackup.s3` 或 `cloudBackup.github`）
    settings: cloudBackup?.[found.id] ?? {},
  };
}

/** 「往哪儿传」这句话，日志和界面共用。凭据一个字都不带。 */
export function describeTarget(cloudBackup) {
  const { label, driver, settings } = driverFor(cloudBackup);
  const where = driver.describe(settings);
  return where ? `${label} ${where}` : label;
}
