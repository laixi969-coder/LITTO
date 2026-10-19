/**
 * 品牌更名：旧版本把界面偏好存在 `toonflow.*` 下，改名后不能把用户已有的项目列表、
 * 引导状态、开发者开关清空。启动时只做一次「新键不存在才从旧键复制」的迁移，
 * 不删除旧键，回退旧版本也不会丢数据。
 */
const BRAND_KEYS = ["projectList", "developer", "hello"] as const;

export function migrateBrandKeys() {
  if (typeof localStorage === "undefined") return;
  for (const name of BRAND_KEYS) {
    const current = `milimili.${name}`;
    const legacies = [`litto.${name}`, `toonflow.${name}`];
    try {
      if (localStorage.getItem(current) !== null) continue;
      for (const legacy of legacies) {
        const value = localStorage.getItem(legacy);
        if (value !== null) { localStorage.setItem(current, value); break; }
      }
    } catch {
      // 隐私模式或配额已满：迁移失败不影响启动，按首次使用处理。
    }
  }
}
