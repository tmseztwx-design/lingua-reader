// 临时测试开关：恢复内测准入时改为 true，再构建前端并部署 scribe-library。
// 只控制新书库的创建；已有书库凭证、私有文件与管理后台鉴权始终保留。
export const BETA_REQUIRED = true; // Deprecated: account login is now mandatory; no open-create switch.
