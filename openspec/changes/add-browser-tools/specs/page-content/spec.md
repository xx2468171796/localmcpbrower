## ADDED Requirements

### Requirement: get_page_content 工具
系统 SHALL 提供 get_page_content 工具，获取页面内容。

#### Scenario: 获取 HTML 内容
- **WHEN** 调用 get_page_content，参数 type="html"
- **THEN** 返回 success=true，data 包含页面完整 HTML

#### Scenario: 获取纯文本内容
- **WHEN** 调用 get_page_content，参数 type="text"
- **THEN** 返回 success=true，data 包含页面纯文本（去除 HTML 标签）

#### Scenario: 获取指定元素内容
- **WHEN** 调用 get_page_content，参数 selector="article", type="html"
- **THEN** 返回 success=true，data 包含指定元素的 HTML

### Requirement: pdf_export 工具
系统 SHALL 提供 pdf_export 工具，将页面导出为 PDF 文件。

#### Scenario: 成功导出 PDF
- **WHEN** 调用 pdf_export，参数 path="output.pdf"
- **THEN** 生成 PDF 文件，返回 success=true，data.path 包含文件路径

#### Scenario: 导出完整页面
- **WHEN** 调用 pdf_export，参数 path="full.pdf", fullPage=true
- **THEN** 生成包含完整页面内容的 PDF

#### Scenario: 导出超时
- **WHEN** 调用 pdf_export，但页面复杂导致超时
- **THEN** 返回 success=false，error="PDF export timeout"
