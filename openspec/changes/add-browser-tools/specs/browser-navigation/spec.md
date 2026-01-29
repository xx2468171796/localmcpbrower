## ADDED Requirements

### Requirement: scroll 工具
系统 SHALL 提供 scroll 工具，支持页面滚动到指定位置或元素。

#### Scenario: 滚动到指定坐标
- **WHEN** 调用 scroll 工具，参数 x=0, y=500
- **THEN** 页面滚动到坐标 (0, 500)

#### Scenario: 滚动到元素
- **WHEN** 调用 scroll 工具，参数 selector="#target"
- **THEN** 页面滚动使目标元素可见

### Requirement: go_back 工具
系统 SHALL 提供 go_back 工具，执行浏览器后退操作。

#### Scenario: 成功后退
- **WHEN** 调用 go_back 工具
- **THEN** 浏览器后退到上一个页面，返回新页面的 URL 和标题

#### Scenario: 无历史记录
- **WHEN** 调用 go_back 工具，但无历史记录
- **THEN** 返回 success=true，页面保持不变

### Requirement: go_forward 工具
系统 SHALL 提供 go_forward 工具，执行浏览器前进操作。

#### Scenario: 成功前进
- **WHEN** 调用 go_forward 工具
- **THEN** 浏览器前进到下一个页面，返回新页面的 URL 和标题

#### Scenario: 无前进历史
- **WHEN** 调用 go_forward 工具，但无前进历史
- **THEN** 返回 success=true，页面保持不变
