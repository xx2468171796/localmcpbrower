## ADDED Requirements

### Requirement: hover 工具
系统 SHALL 提供 hover 工具，将鼠标悬停在指定元素上。

#### Scenario: 成功悬停
- **WHEN** 调用 hover 工具，参数 selector=".menu-item"
- **THEN** 鼠标悬停在元素上，触发 hover 效果

#### Scenario: 元素不存在
- **WHEN** 调用 hover 工具，但元素不存在
- **THEN** 返回 success=false，error 包含错误信息

### Requirement: wait_for_selector 工具
系统 SHALL 提供 wait_for_selector 工具，等待元素达到指定状态。

#### Scenario: 等待元素可见
- **WHEN** 调用 wait_for_selector，参数 selector="#loading", state="hidden", timeout=5000
- **THEN** 等待元素隐藏，成功后返回 success=true

#### Scenario: 等待超时
- **WHEN** 调用 wait_for_selector，但元素未在超时时间内达到状态
- **THEN** 返回 success=false，error="Timeout waiting for selector"

### Requirement: get_element_text 工具
系统 SHALL 提供 get_element_text 工具，获取元素的文本内容。

#### Scenario: 成功获取文本
- **WHEN** 调用 get_element_text，参数 selector="h1"
- **THEN** 返回 success=true，data 包含元素的 textContent

#### Scenario: 元素不存在
- **WHEN** 调用 get_element_text，但元素不存在
- **THEN** 返回 success=false，error 包含错误信息

### Requirement: get_element_attribute 工具
系统 SHALL 提供 get_element_attribute 工具，获取元素的属性值。

#### Scenario: 成功获取属性
- **WHEN** 调用 get_element_attribute，参数 selector="a", attribute="href"
- **THEN** 返回 success=true，data 包含属性值

#### Scenario: 属性不存在
- **WHEN** 调用 get_element_attribute，但属性不存在
- **THEN** 返回 success=true，data=null
