## ADDED Requirements

### Requirement: get_cookies 工具
系统 SHALL 提供 get_cookies 工具，获取当前页面的 Cookie。

#### Scenario: 获取所有 Cookie
- **WHEN** 调用 get_cookies，无参数
- **THEN** 返回 success=true，data 包含所有 Cookie 数组

#### Scenario: 获取指定名称 Cookie
- **WHEN** 调用 get_cookies，参数 name="session_id"
- **THEN** 返回 success=true，data 包含匹配的 Cookie

#### Scenario: Cookie 不存在
- **WHEN** 调用 get_cookies，参数 name="not_exist"
- **THEN** 返回 success=true，data=null

### Requirement: set_cookies 工具
系统 SHALL 提供 set_cookies 工具，设置页面 Cookie。

#### Scenario: 设置单个 Cookie
- **WHEN** 调用 set_cookies，参数 cookies=[{name: "token", value: "abc123", domain: "example.com"}]
- **THEN** Cookie 被设置，返回 success=true

#### Scenario: 设置多个 Cookie
- **WHEN** 调用 set_cookies，参数 cookies=[{name: "a", value: "1"}, {name: "b", value: "2"}]
- **THEN** 所有 Cookie 被设置

#### Scenario: 设置带过期时间的 Cookie
- **WHEN** 调用 set_cookies，参数 cookies=[{name: "token", value: "abc", expires: 1735689600}]
- **THEN** Cookie 被设置，包含正确的过期时间
