## 1. Schema 定义

- [ ] 1.1 在 src/schemas.ts 添加 ScrollSchema
- [ ] 1.2 在 src/schemas.ts 添加 WaitForSelectorSchema
- [ ] 1.3 在 src/schemas.ts 添加 GetElementTextSchema
- [ ] 1.4 在 src/schemas.ts 添加 GetElementAttributeSchema
- [ ] 1.5 在 src/schemas.ts 添加 HoverSchema
- [ ] 1.6 在 src/schemas.ts 添加 SelectOptionSchema
- [ ] 1.7 在 src/schemas.ts 添加 FillFormSchema
- [ ] 1.8 在 src/schemas.ts 添加 GetPageContentSchema
- [ ] 1.9 在 src/schemas.ts 添加 PdfExportSchema
- [ ] 1.10 在 src/schemas.ts 添加 GetCookiesSchema
- [ ] 1.11 在 src/schemas.ts 添加 SetCookiesSchema

## 2. 类型定义

- [ ] 2.1 在 src/types.ts 添加 ScrollResult 类型
- [ ] 2.2 在 src/types.ts 添加 WaitForSelectorResult 类型
- [ ] 2.3 在 src/types.ts 添加 CookieEntry 类型
- [ ] 2.4 在 src/types.ts 添加 FillFormField 类型

## 3. 工具函数实现

- [ ] 3.1 在 src/tools.ts 实现 scroll 函数
- [ ] 3.2 在 src/tools.ts 实现 goBack 函数
- [ ] 3.3 在 src/tools.ts 实现 goForward 函数
- [ ] 3.4 在 src/tools.ts 实现 hover 函数
- [ ] 3.5 在 src/tools.ts 实现 waitForSelector 函数
- [ ] 3.6 在 src/tools.ts 实现 getElementText 函数
- [ ] 3.7 在 src/tools.ts 实现 getElementAttribute 函数
- [ ] 3.8 在 src/tools.ts 实现 selectOption 函数
- [ ] 3.9 在 src/tools.ts 实现 fillForm 函数
- [ ] 3.10 在 src/tools.ts 实现 getPageContent 函数
- [ ] 3.11 在 src/tools.ts 实现 pdfExport 函数
- [ ] 3.12 在 src/tools.ts 实现 getCookies 函数
- [ ] 3.13 在 src/tools.ts 实现 setCookies 函数

## 4. MCP Server 注册

- [ ] 4.1 在 src/server.ts 注册 scroll 工具
- [ ] 4.2 在 src/server.ts 注册 go_back 工具
- [ ] 4.3 在 src/server.ts 注册 go_forward 工具
- [ ] 4.4 在 src/server.ts 注册 hover 工具
- [ ] 4.5 在 src/server.ts 注册 wait_for_selector 工具
- [ ] 4.6 在 src/server.ts 注册 get_element_text 工具
- [ ] 4.7 在 src/server.ts 注册 get_element_attribute 工具
- [ ] 4.8 在 src/server.ts 注册 select_option 工具
- [ ] 4.9 在 src/server.ts 注册 fill_form 工具
- [ ] 4.10 在 src/server.ts 注册 get_page_content 工具
- [ ] 4.11 在 src/server.ts 注册 pdf_export 工具
- [ ] 4.12 在 src/server.ts 注册 get_cookies 工具
- [ ] 4.13 在 src/server.ts 注册 set_cookies 工具

## 5. 构建和测试

- [ ] 5.1 运行 npx tsc 编译
- [ ] 5.2 重启 PM2 服务
- [ ] 5.3 测试新工具功能
