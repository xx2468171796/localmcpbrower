/**
 * 人工接管(elicitation)—— 有头浏览器存在的意义。
 *
 * ## 解决什么
 *
 * 有头浏览器(3213)存在的**唯一**理由就是让人工过验证码 / 登录。但在此之前,
 * 全仓 0 处使用 elicitation:撞到登录墙时工具只能返回一个失败,然后靠 AI 在聊天里
 * 跟用户说「请去登录」,用户登完还得回来告诉 AI 继续 —— 一次人工接管要三轮对话,
 * 而且 AI 经常在等待期间自作主张去干别的。
 *
 * 用 elicitation 之后:工具**自己**把请求弹到用户面前,用户处理完确认,
 * 同一次工具调用**原地继续**。
 *
 * ## 为什么是显式工具,而不是自动检测登录墙
 *
 * 「检测到登录墙就自动弹窗」听起来更聪明,但登录墙没有可靠特征 ——
 * 靠 URL 关键词 / 表单结构 / 文案猜,误判率高。误判成本是**双向**的:
 * 该弹不弹(用户干等)、不该弹乱弹(打断自动化流程,比不弹更烦)。
 *
 * 所以这里给 AI 一个**明确的工具**:它自己判断「这页需要人来」,然后显式调用。
 * 判断交给模型(它能读到页面内容,比正则强得多),机制交给协议。
 *
 * ## 两个纪元都能用
 *
 * 用 `inputRequired(...)` 返回式写法。SDK 自带 legacy shim:在 2025 线客户端上
 * 会被自动转成真实的服务端→客户端请求。所以**这一份代码同时服务两条腿**,
 * 不需要按纪元分叉。
 */

import { z } from 'zod';
import { inputRequired, acceptedContent } from '@modelcontextprotocol/server';

/** 人工确认的应答体 —— 只要一个「做完了没」。刻意保持最小,降低客户端渲染负担。 */
export const HumanAckSchema = z.object({
  done: z.boolean().describe('是否已在浏览器窗口中完成上述操作'),
  note: z.string().max(500).optional().describe('可选备注,例如遇到的问题'),
});

/** 本工具在 inputResponses 里的键名。固定值,重入时靠它取回应答。 */
export const HUMAN_ACK_KEY = 'human_ack';

/**
 * 构造一个「等人工处理」的应答。
 *
 * 调用方(工具 handler)直接 `return buildHumanRequest(...)`,SDK 会把它转成
 * 对客户端的输入请求;用户应答后,同一个工具会被**重新调用**,
 * 此时用 {@link readHumanAck} 取回结果。
 */
export function buildHumanRequest(message: string) {
  return inputRequired({
    inputRequests: {
      [HUMAN_ACK_KEY]: inputRequired.elicit({
        message,
        requestedSchema: {
          type: 'object',
          properties: {
            done: { type: 'boolean', title: '已完成', description: '在浏览器窗口中处理完后勾选' },
            note: { type: 'string', title: '备注(可选)', description: '遇到问题可以写在这里' },
          },
          required: ['done'],
        },
      }),
    },
  });
}

/**
 * 重入时读回人工应答。
 *
 * 返回 `undefined` 表示:还没问过 / 用户拒绝 / 用户取消 / 应答不合 schema ——
 * 这四种情况调用方处理方式相同(要么再问一次,要么放弃),所以不做区分。
 *
 * ⚠️ 应答来自客户端,是**不可信输入**。这里过一遍 schema 校验后才交出去。
 */
export function readHumanAck(inputResponses: unknown): z.infer<typeof HumanAckSchema> | undefined {
  return acceptedContent(
    inputResponses as Record<string, unknown> | undefined,
    HUMAN_ACK_KEY,
    HumanAckSchema,
  );
}
