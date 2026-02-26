export const ERROR_TYPES = {
  PERMISSION_DENIED: 'permission_denied',
  PATH_NOT_FOUND: 'path_not_found',
  PATH_VALIDATION_FAILED: 'path_validation_failed',
  DIR_NOT_EMPTY: 'dir_not_empty',
  TIMEOUT: 'timeout',
  DISK_FULL: 'disk_full',
  READ_ONLY: 'read_only',
  CONFLICT: 'conflict',
  POLICY_SKIPPED: 'policy_skipped',
  UNKNOWN: 'unknown',
};

const ERROR_TYPE_LABELS = {
  [ERROR_TYPES.PERMISSION_DENIED]: '权限不足',
  [ERROR_TYPES.PATH_NOT_FOUND]: '路径不存在',
  [ERROR_TYPES.PATH_VALIDATION_FAILED]: '路径校验失败',
  [ERROR_TYPES.DIR_NOT_EMPTY]: '目录非空',
  [ERROR_TYPES.TIMEOUT]: '执行超时',
  [ERROR_TYPES.DISK_FULL]: '磁盘空间不足',
  [ERROR_TYPES.READ_ONLY]: '只读目录',
  [ERROR_TYPES.CONFLICT]: '路径冲突',
  [ERROR_TYPES.POLICY_SKIPPED]: '策略跳过',
  [ERROR_TYPES.UNKNOWN]: '其他错误',
};

export function errorTypeToLabel(errorType) {
  return ERROR_TYPE_LABELS[String(errorType || '')] || ERROR_TYPE_LABELS[ERROR_TYPES.UNKNOWN];
}

export function classifyErrorType(message) {
  const text = String(message || '').toLowerCase();
  if (!text) {
    return ERROR_TYPES.UNKNOWN;
  }
  if (
    text.includes('eacces') ||
    text.includes('eperm') ||
    text.includes('operation not permitted') ||
    text.includes('permission denied')
  ) {
    return ERROR_TYPES.PERMISSION_DENIED;
  }
  if (
    text.includes('enoent') ||
    text.includes('enotdir') ||
    text.includes('not found') ||
    text.includes('no such file')
  ) {
    return ERROR_TYPES.PATH_NOT_FOUND;
  }
  if (
    text.includes('invalid') ||
    text.includes('illegal') ||
    text.includes('outside') ||
    text.includes('escape')
  ) {
    return ERROR_TYPES.PATH_VALIDATION_FAILED;
  }
  if (text.includes('enotempty')) {
    return ERROR_TYPES.DIR_NOT_EMPTY;
  }
  if (text.includes('timeout')) {
    return ERROR_TYPES.TIMEOUT;
  }
  if (text.includes('enospc') || text.includes('no space')) {
    return ERROR_TYPES.DISK_FULL;
  }
  if (text.includes('read-only') || text.includes('readonly') || text.includes('erofs')) {
    return ERROR_TYPES.READ_ONLY;
  }
  return ERROR_TYPES.UNKNOWN;
}
