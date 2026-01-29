## ADDED Requirements

### Requirement: select_option 工具
系统 SHALL 提供 select_option 工具，选择下拉框选项。

#### Scenario: 按值选择
- **WHEN** 调用 select_option，参数 selector="select#country", value="CN"
- **THEN** 选中 value="CN" 的选项，返回 success=true

#### Scenario: 按标签选择
- **WHEN** 调用 select_option，参数 selector="select#country", label="中国"
- **THEN** 选中显示文本为"中国"的选项

#### Scenario: 选项不存在
- **WHEN** 调用 select_option，但指定的值/标签不存在
- **THEN** 返回 success=false，error 包含错误信息

### Requirement: fill_form 工具
系统 SHALL 提供 fill_form 工具，批量填充表单字段。

#### Scenario: 填充文本字段
- **WHEN** 调用 fill_form，参数 fields=[{selector: "#name", value: "张三"}]
- **THEN** 在 #name 输入框填入"张三"

#### Scenario: 填充多个字段
- **WHEN** 调用 fill_form，参数 fields=[{selector: "#name", value: "张三"}, {selector: "#email", value: "test@example.com"}]
- **THEN** 依次填充所有字段，返回 success=true

#### Scenario: 部分字段失败
- **WHEN** 调用 fill_form，但某些字段选择器无效
- **THEN** 返回 success=false，error 包含失败字段信息
