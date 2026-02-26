import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyErrorType, errorTypeToLabel, ERROR_TYPES } from '../src/error-taxonomy.js';

test('classifyErrorType 能识别常见错误类型', () => {
  assert.equal(classifyErrorType('EACCES: permission denied'), ERROR_TYPES.PERMISSION_DENIED);
  assert.equal(classifyErrorType('ENOENT: no such file or directory'), ERROR_TYPES.PATH_NOT_FOUND);
  assert.equal(classifyErrorType('invalid path segment'), ERROR_TYPES.PATH_VALIDATION_FAILED);
  assert.equal(classifyErrorType('ENOTEMPTY: directory not empty'), ERROR_TYPES.DIR_NOT_EMPTY);
  assert.equal(classifyErrorType('operation timeout after 15s'), ERROR_TYPES.TIMEOUT);
  assert.equal(classifyErrorType('ENOSPC: no space left on device'), ERROR_TYPES.DISK_FULL);
  assert.equal(classifyErrorType('EROFS: read-only file system'), ERROR_TYPES.READ_ONLY);
  assert.equal(classifyErrorType('something else'), ERROR_TYPES.UNKNOWN);
  assert.equal(classifyErrorType(''), ERROR_TYPES.UNKNOWN);
});

test('errorTypeToLabel 返回可读中文标签', () => {
  assert.equal(errorTypeToLabel(ERROR_TYPES.PERMISSION_DENIED), '权限不足');
  assert.equal(errorTypeToLabel(ERROR_TYPES.PATH_NOT_FOUND), '路径不存在');
  assert.equal(errorTypeToLabel(ERROR_TYPES.UNKNOWN), '其他错误');
  assert.equal(errorTypeToLabel('not-exists'), '其他错误');
  assert.equal(errorTypeToLabel(null), '其他错误');
});
