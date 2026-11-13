const DAY = 86_400_000;
const count = x => Number.isSafeInteger(x) && x >= 0;
const time = x => count(x) && x <= 8.64e15;
const efforts = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'unknown']);
const modelValid = x => typeof x === 'string' && /^(?:gpt-[a-z0-9.-]{1,64}|o[1-9][a-z0-9.-]{0,64}|pro-unknown|other|unknown)$/.test(x);
const row = (name, display) => ({ name, display, aside: true });

// Validate before rendering; bridge data must never supply arbitrary labels.
export function localUsageWindows(local) {
  if (local?.status === 'unavailable') return [row('发送记录', '记录读取失败；未归零')];
  if (local?.status === 'identity-unavailable') return [row('发送记录', '账号标识未核实；不合并记录')];
  if (local?.version !== 1 || !['tracking', 'not-started'].includes(local.status) || !time(local.asOf)
    || !count(local.day) || !count(local.week) || local.day > local.week || !count(local.gaps?.day) || !count(local.gaps?.week)
    || local.gaps.day > local.gaps.week || !Array.isArray(local.sources) || local.sources.length > 2
    || new Set(local.sources.map(x => x.source)).size !== local.sources.length
    || !local.sources.every(x => ['native', 'text'].includes(x?.source) && time(x.since) && x.since <= local.asOf)
    || !Array.isArray(local.byModel) || local.byModel.length > 20000
    || !local.byModel.every(x => modelValid(x?.model) && efforts.has(x.effort) && count(x.day) && count(x.week) && x.day <= x.week)
    || local.byModel.reduce((n, x) => n + x.day, 0) !== local.day || local.byModel.reduce((n, x) => n + x.week, 0) !== local.week) return null;
  if (local.status === 'not-started') {
    if (local.since !== null || local.sources.length || local.week || local.gaps.week) return null;
    return [row('发送记录', '尚未开始记录发送'), row('统计范围', '仅本插件已记发送')];
  }
  if (!time(local.since) || local.since > local.asOf || !local.sources.length
    || local.since !== Math.min(...local.sources.map(x => x.since))) return null;
  const windows = [row('本地发送 · 24h', `${local.day} 次已记录`), row('本地发送 · 7天', `${local.week} 次已记录`)];
  const visible = local.byModel.slice(0, 6);
  for (const group of visible) {
    const name = group.model === 'unknown' ? '型号未识别' : group.model === 'pro-unknown' ? 'Pro 型号未识别' : group.model === 'other' ? '其他型号' : group.model;
    windows.push(row(`${name} · ${group.effort === 'unknown' ? '档位未识别' : group.effort}`, `24h ${group.day} · 7天 ${group.week} 次`));
  }
  if (local.byModel.length > visible.length) {
    const rest = local.byModel.slice(visible.length);
    windows.push(row(`其余 ${rest.length} 组`, `24h ${rest.reduce((n, x) => n + x.day, 0)} · 7天 ${rest.reduce((n, x) => n + x.week, 0)} 次`));
  }
  windows.push(row('记录起点 UTC', new Date(local.since).toISOString().slice(0, 16).replace('T', ' ')));
  const elapsed = local.asOf - Math.max(...local.sources.map(x => x.since));
  windows.push(row('覆盖情况', local.gaps.week ? `7天内 ${local.gaps.week} 次记录缺口` : elapsed < DAY ? '不足24h；窗口覆盖不全' : elapsed < 7 * DAY ? '不足7天；窗口覆盖不全' : '记录起点已满7天；外部未计'));
  windows.push(row('记录渠道', local.sources.map(x => x.source === 'native' ? 'Native' : '文本').join(' + ')));
  windows.push(row('统计范围', '仅本插件已记发送'));
  windows.push(row('未统计范围', '此前及外部发送'));
  // No used/amount/limit/balance/reset fields: these are counts, not a measured
  // percent. The host otherwise uses them for account routing and % meters.
  return windows;
}
