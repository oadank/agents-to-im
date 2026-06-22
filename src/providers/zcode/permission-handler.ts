/**
 * Permission Handler — 处理 ZCode agents 的工具权限审批
 * 通过 PermissionGateway.waitForPendingPermission() 等待用户在飞书中审批
 */

import { randomUUID } from 'node:crypto';
import { getBridgeContext } from '../../bridge/context.js';
import type { PermissionResult } from '../claude/permission-gateway.js';
import { isAutoApprove } from './tool-executor.js';

/**
 * 请求工具执行权限
 * - 自动批准的工具直接返回 allow
 * - 需要审批的工具：生成 permissionRequestId，等待用户在飞书中点击按钮
 *
 * @returns PermissionResult — allow 表示可以执行，deny 表示拒绝
 */
export async function requestToolPermission(
  toolName: string,
  toolInput: Record<string, unknown>,
  emitEvent: (event: { type: string; data: string }) => void,
  sessionId?: string,
): Promise<PermissionResult> {
  // 自动批准的工具
  if (isAutoApprove(toolName)) {
    return { behavior: 'allow' };
  }

  // 检查全局自动批准
  if (process.env.CTI_AUTO_APPROVE === 'true' || process.env.CTI_AUTO_APPROVE === '1') {
    return { behavior: 'allow', scope: 'session' };
  }

  // 生成唯一的 permission request ID
  const permissionRequestId = `zcode-perm-${randomUUID()}`;

  // 发送 permission_request SSE 事件
  // 对话引擎会捕获这个事件，通过 permission-broker 发送飞书审批卡片
  emitEvent({
    type: 'permission_request',
    data: JSON.stringify({
      permissionRequestId,
      toolName,
      toolInput,
      suggestions: [],
    }),
  });

  console.log(`[zcode-perm] Waiting for permission: ${permissionRequestId} tool=${toolName}`);

  // 通过 gateway 等待用户在飞书中点击按钮
  const { permissions } = getBridgeContext();
  if (!permissions.waitForPendingPermission) {
    throw new Error('PermissionGateway does not support waitForPendingPermission');
  }
  const result = await permissions.waitForPendingPermission(permissionRequestId);

  console.log(`[zcode-perm] Permission resolved: ${permissionRequestId} → ${result.behavior}`);
  return result;
}
