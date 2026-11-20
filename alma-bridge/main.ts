/**
 * dsh-pet × Alma 桥接插件（草稿 v0.1，未实测）。
 *
 * 作用：订阅 Alma 的 agent 事件，把任务状态推给独立运行的 dsh-pet
 * （独立模式在本机 3080 端口提供 /dsh-pet-7340 HTTP 接口）。
 *
 * 状态映射（Alma hooks → 宠物 work-status 档位）：
 * - chat.message.willSend / tool.willExecute → working（工作中）
 * - chat.message.didReceive                     → success（完成，12 秒后回空闲）
 * - tool.onError                                → error（出错，12 秒后回空闲）
 * - 长时间无活动 / app.willQuit / 插件停用       → DELETE /work-status（回空闲）
 *
 * 只用不需占用锁的端点：POST/DELETE /work-status；celebrateAnim 配了才调 POST /anim。
 * 聊天本身不走这里：宠物对话直接配它自己的 AI 设置（custom 服务商 + 用户 API + deepseek v4.1 flash）。
 */
import type { PluginContext, PluginActivation } from 'alma-plugin-api';

type PetWorkState = 'thinking' | 'working' | 'result' | 'waiting' | 'success' | 'error';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3080';
const IDLE_DELAY_MS = 12_000;
const FETCH_TIMEOUT_MS = 5_000;

/** 截成最多 40 个码点（宠物 work-status 的 task 上限）。 */
function truncateTask(text: string): string {
    const points = Array.from(text.trim());
    return points.length > 40 ? points.slice(0, 40).join('') : points.join('');
}

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, events, settings, ui } = context;

    const baseUrl = () => settings.get<string>('dshPetAlmaBridge.petBaseUrl', DEFAULT_BASE_URL);
    const celebrateAnim = () =>
        settings.get<string>('dshPetAlmaBridge.celebrateAnim', '');
    const enabled = () => settings.get<boolean>('dshPetAlmaBridge.enabled', true);

    const statusBar = ui.createStatusBarItem({ id: 'dsh-pet-alma-bridge', alignment: 'left' });
    statusBar.text = '小肥鱼：空闲';
    statusBar.show();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let petReachable = false;

    function setStatusBar(text: string): void {
        statusBar.text = text;
    }

    async function postJson(path: string, init: RequestInit): Promise<boolean> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(`${baseUrl()}${path}`, {
                ...init,
                signal: controller.signal,
            });
            if (!res.ok) {
                logger.warn(`宠物接口 ${path} 返回 HTTP ${res.status}`);
                return false;
            }
            return true;
        } catch (error) {
            logger.warn(
                `连不上宠物（${baseUrl()}）：${error instanceof Error ? error.message : String(error)}`,
            );
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    async function setWorkStatus(state: PetWorkState, task?: string | null): Promise<void> {
        const body: Record<string, unknown> = { state };
        if (task !== undefined) body.task = task;
        const ok = await postJson('/dsh-pet-7340/work-status', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        petReachable = ok;
        setStatusBar(ok ? `小肥鱼：${stateLabel(state)}` : '小肥鱼：未连接');
    }

    async function clearWorkStatus(): Promise<void> {
        await postJson('/dsh-pet-7340/work-status', { method: 'DELETE' });
        setStatusBar('小肥鱼：空闲');
    }

    function scheduleIdle(): void {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            void clearWorkStatus().catch((error: unknown) => {
                logger.warn(`回空闲失败：${error instanceof Error ? error.message : String(error)}`);
            });
        }, IDLE_DELAY_MS);
    }

    function cancelIdle(): void {
        clearTimeout(idleTimer);
        idleTimer = undefined;
    }

    async function playCelebrate(): Promise<void> {
        const name = celebrateAnim();
        if (!name) return;
        const petId = settings.get<string>('dshPetAlmaBridge.petId', 'main');
        await postJson(`/dsh-pet-7340/anim?pet=${encodeURIComponent(petId)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
        });
    }

    const disposables = [
        events.on('chat.message.willSend', (input) => {
            if (!enabled()) return;
            cancelIdle();
            void setWorkStatus('working', truncateTask(input.content)).catch((error: unknown) => {
                logger.warn(`推 working 失败：${String(error)}`);
            });
        }),
        events.on('tool.willExecute', (input) => {
            if (!enabled()) return;
            cancelIdle();
            void setWorkStatus('working').catch((error: unknown) => {
                logger.warn(`推 working 失败：${String(error)}`);
            });
            logger.debug(`工具开始：${input.tool}`);
        }),
        events.on('tool.didExecute', () => {
            // 回合还没完，等 didReceive 再报完成；这里只续一下工作态。
            if (!enabled()) return;
            cancelIdle();
        }),
        events.on('chat.message.didReceive', () => {
            if (!enabled()) return;
            void setWorkStatus('success')
                .then(() => playCelebrate())
                .catch((error: unknown) => {
                    logger.warn(`推 success 失败：${String(error)}`);
                });
            scheduleIdle();
        }),
        events.on('tool.onError', (input) => {
            if (!enabled()) return;
            void setWorkStatus('error', truncateTask(`工具 ${input.tool} 出错`)).catch(
                (error: unknown) => {
                    logger.warn(`推 error 失败：${String(error)}`);
                },
            );
            scheduleIdle();
        }),
        events.on('app.ready', () => {
            logger.info('小肥鱼桥接已就绪，宠物接口：' + baseUrl());
            void postJson('/dsh-pet-7340/state', { method: 'GET' }).then((ok) => {
                petReachable = ok;
                setStatusBar(ok ? '小肥鱼：空闲' : '小肥鱼：未连接');
                if (!ok) {
                    logger.warn(
                        '没连上宠物：请先启动独立模式（dsh-pet-standalone，默认端口 3080），再在插件设置里核对地址。',
                    );
                }
            });
        }),
        events.on('app.willQuit', async () => {
            cancelIdle();
            await clearWorkStatus();
        }),
        settings.onDidChange((event) => {
            if (event.key === 'dshPetAlmaBridge.petBaseUrl') {
                logger.info(`宠物地址改成 ${String(event.newValue)}，下次事件起生效`);
            }
        }),
    ];

    logger.info('小肥鱼桥接插件已激活');

    return {
        dispose: async () => {
            cancelIdle();
            disposables.forEach((d) => d.dispose());
            statusBar.dispose();
            await clearWorkStatus();
            logger.info('小肥鱼桥接插件已停用');
        },
    };
}

function stateLabel(state: PetWorkState): string {
    switch (state) {
        case 'thinking':
            return '思考中';
        case 'working':
            return '工作中';
        case 'result':
            return '出结果';
        case 'waiting':
            return '等输入';
        case 'success':
            return '完成';
        case 'error':
            return '出错';
    }
}
