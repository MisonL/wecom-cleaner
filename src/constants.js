import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'wecom-cleaner';
export const PACKAGE_NAME = '@mison/wecom-cleaner';
export const APP_ASCII_LOGO = [
  ' __      _____ ___  ___  __  __',
  ' \\ \\ /\\ / / __/ __|/ _ \\|  \\/  |',
  '  \\ V  V /| _| (__| (_) | |\\/| |',
  '   \\_/\\_/ |___\\___|\\___/|_|  |_|',
  '  ___ _    ___   _   _ _  _ ___ ___',
  ' / __| |  | __| /_\\ | \\| | __| _ \\',
  '| (__| |__| _| / _ \\| .` | _||   /',
  ' \\___|____|___/_/ \\_\\_|\\_|___|_|_\\',
];

export const DEFAULT_PROFILE_ROOT = path.join(
  os.homedir(),
  'Library/Containers/com.tencent.WeWorkMac/Data/Documents/Profiles'
);

export const DEFAULT_STATE_ROOT = path.join(os.homedir(), '.wecom-cleaner-state');

export const MONTH_RE = /^(?<y>\d{4})-(?<m>\d{1,2})$/;

export const CACHE_CATEGORIES = [
  {
    key: 'images',
    label: '聊天图片',
    desc: '会话中的图片、截图等缓存。',
    relativePath: 'Caches/Images',
  },
  {
    key: 'videos',
    label: '聊天视频',
    desc: '会话中的视频缓存。',
    relativePath: 'Caches/Videos',
  },
  {
    key: 'files',
    label: '聊天文件',
    desc: '会话文件缓存（文档、压缩包等）。',
    relativePath: 'Caches/Files',
  },
  {
    key: 'emotions',
    label: '表情资源',
    desc: '表情大图、表情资源缓存。',
    relativePath: 'Caches/Emotions',
  },
  {
    key: 'emotion_thumbnails',
    label: '表情缩略图',
    desc: '表情预览图缓存。',
    relativePath: 'Caches/Emotion_Thumbnail',
  },
  {
    key: 'video_thumbnails',
    label: '视频缩略图',
    desc: '视频封面和预览图缓存。',
    relativePath: 'Caches/Video_Thumbnail',
  },
  {
    key: 'link_thumbnails',
    label: '链接缩略图',
    desc: '网页卡片预览图缓存。',
    relativePath: 'Caches/Link_Thumbnail',
  },
  {
    key: 'voices',
    label: '语音消息',
    desc: '语音消息音频缓存。',
    relativePath: 'Caches/Voices',
  },
];

export const CATEGORY_MAP = new Map(CACHE_CATEGORIES.map((item) => [item.key, item]));

export const MODES = {
  START: 'start',
  CLEANUP_MONTHLY: 'cleanup_monthly',
  ANALYSIS_ONLY: 'analysis_only',
  RESTORE: 'restore',
  SETTINGS: 'settings',
};

export const CLEANUP_PRESETS = [
  {
    key: 'safe_2y',
    label: '保守（2年前，表情+缩略图）',
    days: 730,
    categories: ['emotions', 'emotion_thumbnails', 'video_thumbnails', 'link_thumbnails'],
    includeNonMonthDirs: false,
  },
  {
    key: 'balanced_1y',
    label: '平衡（1年前，全量缓存）',
    days: 365,
    categories: CACHE_CATEGORIES.map((x) => x.key),
    includeNonMonthDirs: false,
  },
  {
    key: 'aggressive_6m',
    label: '激进（6个月，全量+非月份目录）',
    days: 180,
    categories: CACHE_CATEGORIES.map((x) => x.key),
    includeNonMonthDirs: true,
  },
  {
    key: 'custom',
    label: '自定义',
    days: null,
    categories: [],
    includeNonMonthDirs: false,
  },
];

export const USER_LABEL_STOPWORDS = new Set([
  '真实姓名',
  '企业介绍',
  '我的业务',
  '新学期准备',
  '帮助企业',
]);

export const CORP_LABEL_STOPWORDS = new Set([
  '新学期准备',
  '腾讯科技股份有限公司',
  '其他',
]);

export const CJK_TEXT_RE = /[\u4e00-\u9fff]{2,24}/g;
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
