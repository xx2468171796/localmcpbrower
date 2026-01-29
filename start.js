#!/usr/bin/env node
/**
 * 一键启动脚本
 * @description 启动 MCP Bridge 服务并输出配置信息
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3211;

// MCP 配置信息 (Streamable HTTP - 现代标准)
const mcpConfig = {
  "mcpServers": {
    "stable-browser": {
      "serverUrl": `http://localhost:${PORT}/mcp`
    }
  }
};

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║     Windsurf MCP Bridge - Streamable HTTP                    ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

console.log('📋 复制以下配置到 Windsurf MCP 设置中:\n');
console.log('─'.repeat(60));
console.log(JSON.stringify(mcpConfig, null, 2));
console.log('─'.repeat(60));

console.log('\n🔗 服务地址:');
console.log(`   MCP 端点: http://localhost:${PORT}/mcp (Streamable HTTP)`);
console.log(`   健康检查: http://localhost:${PORT}/health`);
console.log(`   连接状态: http://localhost:${PORT}/connections\n`);

console.log('⏳ 正在启动服务...\n');

// 启动服务
const serverPath = join(__dirname, 'dist', 'server.js');
const child = spawn('node', [serverPath], {
  stdio: 'inherit',
  env: { ...process.env, PORT: String(PORT) }
});

child.on('error', (err) => {
  console.error('❌ 启动失败:', err.message);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n🛑 正在关闭服务...');
  child.kill('SIGINT');
});

process.on('SIGTERM', () => {
  child.kill('SIGTERM');
});
