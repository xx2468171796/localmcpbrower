# browser-singleton Spec

## 概述
浏览器单例管理器，负责 Playwright 实例的生命周期管理。

## 接口定义

```typescript
interface BrowserManager {
  // 获取或创建浏览器实例
  getContext(): Promise<BrowserContext>;
  
  // 获取当前活动页面
  getPage(): Promise<Page>;
  
  // 关闭浏览器
  close(): Promise<void>;
  
  // 检查浏览器是否存活
  isAlive(): boolean;
}
```

## 行为规范

1. **单例模式**: 全局只维护一个 BrowserContext 实例
2. **持久化**: 使用 `launchPersistentContext`，数据存储在 `storage/user_data`
3. **可视化**: 默认 `headless: false`，可通过环境变量配置
4. **自动恢复**: 浏览器崩溃时自动重新创建实例

## 配置项

| 配置 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `HEADLESS` | boolean | false | 是否无头模式 |
| `USER_DATA_DIR` | string | `storage/user_data` | 用户数据目录 |
| `VIEWPORT_WIDTH` | number | 1280 | 视口宽度 |
| `VIEWPORT_HEIGHT` | number | 720 | 视口高度 |

## 依赖
- playwright
