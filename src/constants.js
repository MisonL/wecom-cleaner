import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'wecom-cleaner';
export const PACKAGE_NAME = '@mison/wecom-cleaner';
export const APP_ASCII_LOGO = {
  wecom: [
    '██     ██ ███████  ██████   ██████  ███    ███',
    '██     ██ ██      ██      ██    ██ ████  ████',
    '██  █  ██ █████   ██      ██    ██ ██ ████ ██',
    '██ ███ ██ ██      ██      ██    ██ ██  ██  ██',
    ' ███ ███  ███████  ██████   ██████  ██      ██',
  ],
  cleaner: [
    ' ██████ ██      ███████  █████  ███    ██ ███████ ██████',
    '██      ██      ██      ██   ██ ████   ██ ██      ██   ██',
    '██      ██      █████   ███████ ██ ██  ██ █████   ██████',
    '██      ██      ██      ██   ██ ██  ██ ██ ██      ██   ██',
    ' ██████ ███████ ███████ ██   ██ ██   ████ ███████ ██   ██',
  ],
  subtitle: 'WeCom Cache Cleaner',
};

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
    defaultSelected: true,
  },
  {
    key: 'videos',
    label: '聊天视频',
    desc: '会话中的视频缓存。',
    relativePath: 'Caches/Videos',
    defaultSelected: true,
  },
  {
    key: 'files',
    label: '聊天文件',
    desc: '会话文件缓存（文档、压缩包等）。',
    relativePath: 'Caches/Files',
    defaultSelected: true,
  },
  {
    key: 'emotions',
    label: '表情资源',
    desc: '表情大图、表情资源缓存。',
    relativePath: 'Caches/Emotions',
    defaultSelected: true,
  },
  {
    key: 'emotion_thumbnails',
    label: '表情缩略图',
    desc: '表情预览图缓存。',
    relativePath: 'Caches/Emotion_Thumbnail',
    defaultSelected: true,
  },
  {
    key: 'video_thumbnails',
    label: '视频缩略图',
    desc: '视频封面和预览图缓存。',
    relativePath: 'Caches/Video_Thumbnail',
    defaultSelected: true,
  },
  {
    key: 'link_thumbnails',
    label: '链接缩略图',
    desc: '网页卡片预览图缓存。',
    relativePath: 'Caches/Link_Thumbnail',
    defaultSelected: true,
  },
  {
    key: 'voices',
    label: '语音消息',
    desc: '语音消息音频缓存。',
    relativePath: 'Caches/Voices',
    defaultSelected: true,
  },
  {
    key: 'wwsecurity',
    label: '受保护截图缓存',
    desc: 'wwsecurity 多层截图缓存。默认仅分析，清理需手动勾选。',
    relativePath: 'Caches/wwsecurity',
    defaultSelected: false,
  },
];

export const CATEGORY_MAP = new Map(CACHE_CATEGORIES.map((item) => [item.key, item]));

export const MODES = {
  START: 'start',
  CLEANUP_MONTHLY: 'cleanup_monthly',
  ANALYSIS_ONLY: 'analysis_only',
  SPACE_GOVERNANCE: 'space_governance',
  RESTORE: 'restore',
  SETTINGS: 'settings',
};

export const SPACE_GOVERNANCE_TIERS = {
  SAFE: 'safe',
  CAUTION: 'caution',
  PROTECTED: 'protected',
};

export const SPACE_GOVERNANCE_TIER_LABELS = new Map([
  [SPACE_GOVERNANCE_TIERS.SAFE, '安全层'],
  [SPACE_GOVERNANCE_TIERS.CAUTION, '谨慎层'],
  [SPACE_GOVERNANCE_TIERS.PROTECTED, '受保护层'],
]);

export const SPACE_GOVERNANCE_TARGETS = [
  {
    key: 'wxwork_temp_screencapture',
    label: '临时截图',
    desc: '企业微信截图临时目录，长期积累明显。',
    tier: SPACE_GOVERNANCE_TIERS.SAFE,
    scope: 'data_root',
    relativePath: 'Library/Application Support/WXWork/Temp/ScreenCapture',
  },
  {
    key: 'wxwork_temp_wetype_realpic',
    label: '临时图片输入缓存',
    desc: '输入法临时图片缓存。',
    tier: SPACE_GOVERNANCE_TIERS.SAFE,
    scope: 'data_root',
    relativePath: 'Library/Application Support/WXWork/Temp/wetype/realPic',
  },
  {
    key: 'wxwork_temp_ftn_local_cache',
    label: '文件传输临时缓存',
    desc: '文件传输临时目录。',
    tier: SPACE_GOVERNANCE_TIERS.SAFE,
    scope: 'data_root',
    relativePath: 'Library/Application Support/WXWork/Temp/FtnLocalCache',
  },
  {
    key: 'wxwork_temp_voip',
    label: '音视频临时目录',
    desc: '音视频临时缓存目录。',
    tier: SPACE_GOVERNANCE_TIERS.SAFE,
    scope: 'data_root',
    relativePath: 'Library/Application Support/WXWork/Temp/Voip',
  },
  {
    key: 'container_tmp',
    label: '容器临时目录(tmp)',
    desc: '应用容器临时目录，通常可安全清理。',
    tier: SPACE_GOVERNANCE_TIERS.SAFE,
    scope: 'data_root',
    relativePath: 'tmp',
  },
  {
    key: 'documents_log',
    label: '运行日志目录(log)',
    desc: '企业微信运行日志目录，清理后会按需重新生成。',
    tier: SPACE_GOVERNANCE_TIERS.SAFE,
    scope: 'data_root',
    relativePath: 'Documents/log',
  },
  {
    key: 'documents_gylog',
    label: 'GY日志目录',
    desc: '企业微信内部日志目录，通常可安全清理。',
    tier: SPACE_GOVERNANCE_TIERS.SAFE,
    scope: 'data_root',
    relativePath: 'Documents/GYLog',
  },
  {
    key: 'documents_gyosslog',
    label: 'GYOss日志目录',
    desc: '企业微信内部日志目录，通常可安全清理。',
    tier: SPACE_GOVERNANCE_TIERS.SAFE,
    scope: 'data_root',
    relativePath: 'Documents/GYOssLog',
  },
  {
    key: 'documents_user_avatar_url',
    label: '头像URL缓存',
    desc: '头像 URL 映射缓存，清理后会自动重建。',
    tier: SPACE_GOVERNANCE_TIERS.SAFE,
    scope: 'data_root',
    relativePath: 'Documents/UserAvatarUrl',
  },
  {
    key: 'profiles_secsdk_tmp',
    label: '安全SDK临时目录',
    desc: '账号目录下 SecSdk 临时文件。',
    tier: SPACE_GOVERNANCE_TIERS.SAFE,
    scope: 'profile',
    relativePath: 'SecSdk/tmp',
  },
  {
    key: 'profiles_sqlite_temp_dir',
    label: 'SQLite临时目录',
    desc: '账号目录下 sqlite_temp_dir 临时文件。',
    tier: SPACE_GOVERNANCE_TIERS.SAFE,
    scope: 'profile',
    relativePath: 'sqlite_temp_dir',
  },
  {
    key: 'profiles_publishsys_pkg',
    label: '文档组件缓存(Publishsys/pkg)',
    desc: '在线文档组件与脚本缓存，清理后首次打开会重新下载。',
    tier: SPACE_GOVERNANCE_TIERS.CAUTION,
    scope: 'profile',
    relativePath: 'Publishsys/pkg',
  },
  {
    key: 'profiles_voip',
    label: '账号音视频目录(VOIP)',
    desc: '账号目录下音视频缓存，清理后可能触发重新拉取。',
    tier: SPACE_GOVERNANCE_TIERS.CAUTION,
    scope: 'profile',
    relativePath: 'VOIP',
  },
  {
    key: 'wxwork_log',
    label: 'WXWork日志目录',
    desc: '应用日志目录，可清理但建议保留近期日志用于排障。',
    tier: SPACE_GOVERNANCE_TIERS.CAUTION,
    scope: 'data_root',
    relativePath: 'Library/Application Support/WXWork/Log',
  },
  {
    key: 'wedrive_temp',
    label: '微盘临时目录(.Temp)',
    desc: '微盘临时传输目录，清理前请确认无正在同步任务。',
    tier: SPACE_GOVERNANCE_TIERS.CAUTION,
    scope: 'data_root',
    relativePath: 'WeDrive/.Temp',
  },
  {
    key: 'wedrive_upload_temp',
    label: '微盘上传临时目录(.C2CUploadTemp)',
    desc: '微盘上传临时目录，清理前请确认无正在上传任务。',
    tier: SPACE_GOVERNANCE_TIERS.CAUTION,
    scope: 'data_root',
    relativePath: 'WeDrive/.C2CUploadTemp',
  },
  {
    key: 'wedrive_trash',
    label: '微盘回收目录(.WeDriveTrash-*)',
    desc: '微盘回收区目录，清理后不能在微盘回收区找回。',
    tier: SPACE_GOVERNANCE_TIERS.CAUTION,
    scope: 'data_root',
    relativePath: 'WeDrive/.WeDriveTrash-*',
  },
  {
    key: 'documents_cefcache',
    label: '内置网页缓存',
    desc: 'Web 内核缓存目录，清理后可能短时触发重新加载。',
    tier: SPACE_GOVERNANCE_TIERS.CAUTION,
    scope: 'data_root',
    relativePath: 'Documents/cefcache',
  },
  {
    key: 'webkit_website_data_store',
    label: 'WebsiteDataStore 缓存',
    desc: 'WebKit 网站数据缓存，清理后会重新建立。',
    tier: SPACE_GOVERNANCE_TIERS.CAUTION,
    scope: 'data_root',
    relativePath: 'Library/WebKit/WebsiteDataStore',
  },
  {
    key: 'library_caches',
    label: '容器通用缓存',
    desc: '应用容器下系统级缓存目录。',
    tier: SPACE_GOVERNANCE_TIERS.CAUTION,
    scope: 'data_root',
    relativePath: 'Library/Caches',
  },
  {
    key: 'profiles_wwsecurity',
    label: '受保护截图缓存(wwsecurity)',
    desc: 'Profiles 下多层截图缓存目录。',
    tier: SPACE_GOVERNANCE_TIERS.CAUTION,
    scope: 'profile',
    relativePath: 'Caches/wwsecurity',
  },
  {
    key: 'wxwork_data_core',
    label: '核心业务数据目录',
    desc: '核心数据区，仅支持分析，不允许删除。',
    tier: SPACE_GOVERNANCE_TIERS.PROTECTED,
    scope: 'data_root',
    relativePath: 'Library/Application Support/WXWork/Data',
    deletable: false,
  },
];

export const USER_LABEL_STOPWORDS = new Set(['真实姓名', '企业介绍', '我的业务', '新学期准备', '帮助企业']);

export const CORP_LABEL_STOPWORDS = new Set(['新学期准备', '腾讯科技股份有限公司', '其他']);

export const CJK_TEXT_RE = /[\u4e00-\u9fff]{2,24}/g;
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
