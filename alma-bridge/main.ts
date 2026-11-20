/**
 * dsh-pet × Alma 桥接插件 v0.2。
 *
 * 作用：订阅 Alma 的 agent 事件，把任务状态推给正在跑的 dsh-pet
 * （宠物宿主在 /dsh-pet-7340 前缀下提供 HTTP 接口）。
 *
 * 状态映射（Alma hooks → 宠物 work-status 档位）：
 * - chat.message.willSend / tool.willExecute → working（工作中）
 * - chat.message.didReceive                   → success（完成，12 秒后回空闲）
 * - tool.onError                              → error（出错，12 秒后回空闲）
 * - 长时间无活动 / app.willQuit / 插件停用     → DELETE /work-status（回空闲）
 *
 * 端口自动发现（v0.2 新增）：
 * - DSH 桌面版每次启动的 web 端口是随机的，独立模式（dsh-pet.exe）也是随机端口，
 *   所以写死 3080 基本连不上。这里按顺序找：
 *     1. 设置里显式配的 petBaseUrl
 *     2. ~/.dsh/dsh-pet/logs.txt 里最近出现过的 http://127.0.0.1:<port>/dsh-pet-<n>
 *     3. 兜底：扫本机端口（常见端口 + 49152-65535 临时端口段）
 *   探到能回 200 的地址就缓存 60 秒，一次失败会作废重找。
 *
 * 只用不需占用锁的端点：POST/DELETE /work-status；celebrateAnim 配了才调 POST /anim。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PluginContext, PluginActivation } from 'alma-plugin-api';

type PetWorkState = 'thinking' | 'working' | 'result' | 'waiting' | 'success' | 'error';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3080';
const PET_PREFIX = '/dsh-pet-7340';
const IDLE_DELAY_MS = 12_000;
const FETCH_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 1_200;
const RESOLVE_TTL_MS = 60_000;

/** Alma 会往用户消息里塞元信息块：[Context: …]、[Message sent-at: …]、[The user is replying to …] 等。 */
const META_BLOCK_HEAD = /^\[(?:Context:|Message sent-at:|Attachment|The user is replying|Reminder|System|Voice)/i;
const META_BLOCK_HINTS = /(?:sender local time|Quoted excerpt|message id|Authoritative Local DateTime|<reminder>)/i;

/** 取从开头左括号到配对右括号的整块；括号不配对时返回 undefined。 */
function leadingBracketBlock(text: string): { block: string; rest: string } | undefined {
    if (!text.startsWith('[')) return undefined;
    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '[') depth += 1;
        else if (ch === ']') {
            depth -= 1;
            if (depth === 0) return { block: text.slice(0, i + 1), rest: text.slice(i + 1) };
            if (depth < 0) return undefined;
        }
    }
    return undefined;
}

/** 去掉开头的元信息块，压平空白，只留用户真正说的话。 */
function cleanTask(text: string): string {
    let out = text.replace(/^\s+/, '');
    for (let round = 0; round < 8; round += 1) {
        out = out.replace(/^<reminder>[\s\S]*?<\/reminder>\s*/i, '').replace(/^<context>[\s\S]*?<\/context>\s*/i, '').replace(/^\s+/, '');
        const found = leadingBracketBlock(out);
        if (!found) {
            // 括号不配对（Alma 有时只给前半截）：只要开头是已知元信息，就按空行切掉这一段。
            if (!META_BLOCK_HEAD.test(out)) break;
            const cut = out.indexOf('\n\n');
            out = cut < 0 ? '' : out.slice(cut + 2).replace(/^\s+/, '');
            continue;
        }
        if (!META_BLOCK_HEAD.test(found.block) && !META_BLOCK_HINTS.test(found.block)) break;
        out = found.rest.replace(/^\s+/, '');
    }
    return out.replace(/\s+/g, ' ').trim();
}

/** 清洗后还残留这些字样，说明元信息没剥干净，改用固定文案，绝不让英文漏进气泡。 */
const META_LEAK =
    /(?:Message sent-at|sender local time|The user is replying|Quoted excerpt|<reminder|<\/reminder>|Authoritative Local DateTime|EMOTION SYSTEM)/i;

const FALLBACK_TASK = '在处理你的消息';

/** 用户消息 → 气泡文案：清洗 → 残留检查 → 截 40 码点。 */
function taskFromMessage(text: string): string {
    const cleaned = cleanTask(text);
    if (cleaned.length === 0 || META_LEAK.test(cleaned)) return FALLBACK_TASK;
    const points = Array.from(cleaned);
    return points.length > 40 ? points.slice(0, 40).join('') : points.join('');
}

/** 截成最多 40 个码点（宠物 work-status 的 task 上限）。 */
function truncateTask(text: string): string {
    const points = Array.from(cleanTask(text));
    return points.length > 40 ? points.slice(0, 40).join('') : points.join('');
}

/** 从宠物日志里翻最近的宿主地址（DSH 桌面版与独立模式都会写这一份）。 */
function logCandidates(): string[] {
    const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
    );
    const out: string[] = [];
    for (const home of homes) {
        let text = '';
        try {
            text = readFileSync(join(home, 'dsh-pet', 'logs.txt'), 'utf8');
        } catch {
            continue;
        }
        const matches = [...text.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/dsh-pet-\d+/g)];
        for (let i = matches.length - 1; i >= 0 && out.length < 8; i -= 1) {
            const base = 'http://127.0.0.1:' + matches[i][1];
            if (!out.includes(base)) out.push(base);
        }
    }
    return out;
}

/** 兜底扫描用的端口清单：常见端口在前，然后是本机临时端口段。 */
function scanPorts(): number[] {
    const ports = [3080, 3081, 3082, 8080, 3000, 5173];
    for (let port = 49152; port <= 65535; port += 1) ports.push(port);
    return ports;
}

async function probe(base: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const res = await fetch(base + PET_PREFIX + '/state', { signal: controller.signal });
        if (!res.ok) return false;
        const body = (await res.json()) as { sections?: unknown };
        return typeof body === 'object' && body !== null && 'sections' in body;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** 并发探一批端口，返回第一个能连上的地址。 */
async function scanForPet(): Promise<string | undefined> {
    const ports = scanPorts();
    const batchSize = 256;
    for (let start = 0; start < ports.length; start += batchSize) {
        const batch = ports.slice(start, start + batchSize);
        const hits = await Promise.all(
            batch.map(async (port) => {
                const base = 'http://127.0.0.1:' + port;
                return (await probe(base)) ? base : undefined;
            }),
        );
        const hit = hits.find((item) => item !== undefined);
        if (hit) return hit;
    }
    return undefined;
}

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, events, settings, ui } = context;

    const configuredUrl = () => settings.get<string>('dshPetAlmaBridge.petBaseUrl', DEFAULT_BASE_URL);
    const celebrateAnim = () => settings.get<string>('dshPetAlmaBridge.celebrateAnim', '');
    const enabled = () => settings.get<boolean>('dshPetAlmaBridge.enabled', true);
    const autoDiscover = () => settings.get<boolean>('dshPetAlmaBridge.autoDiscover', true);

    const statusBar = ui.createStatusBarItem({ id: 'dsh-pet-alma-bridge', alignment: 'left' });
    statusBar.text = '小肥鱼：空闲';
    statusBar.show();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let cachedBase: string | undefined;
    let cachedAt = 0;
    let resolving: Promise<string | undefined> | undefined;

    function setStatusBar(text: string): void {
        statusBar.text = text;
    }

    function remember(base: string): string {
        cachedBase = base;
        cachedAt = Date.now();
        return base;
    }

    function forgetBase(): void {
        cachedBase = undefined;
        cachedAt = 0;
    }

    /** 找到能用（GET /state 回 200）的宠物地址；结果缓存 60 秒。 */
    async function resolveBase(force = false): Promise<string | undefined> {
        if (!force && cachedBase && Date.now() - cachedAt < RESOLVE_TTL_MS) return cachedBase;
        if (resolving) return resolving;
        resolving = (async () => {
            const configured = configuredUrl().trim();
            if (configured.length > 0 && (await probe(configured))) return remember(configured);
            if (!autoDiscover()) return undefined;
            for (const base of logCandidates()) {
                if (base === configured) continue;
                if (await probe(base)) {
                    logger.info('从宠物日志找到宿主：' + base);
                    return remember(base);
                }
            }
            const scanned = await scanForPet();
            if (scanned) {
                logger.info('扫描找到宠物宿主：' + scanned);
                return remember(scanned);
            }
            return undefined;
        })();
        try {
            return await resolving;
        } finally {
            resolving = undefined;
        }
    }

    async function postJson(path: string, init: RequestInit): Promise<boolean> {
        const base = await resolveBase();
        if (!base) {
            setStatusBar('小肥鱼：未连接');
            return false;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(base + path, {
                ...init,
                signal: controller.signal,
            });
            if (!res.ok) {
                logger.warn('宠物接口 ' + path + ' 返回 HTTP ' + res.status);
                forgetBase();
                return false;
            }
            return true;
        } catch (error) {
            logger.warn(
                '连不上宠物（' + base + '）：' + (error instanceof Error ? error.message : String(error)),
            );
            forgetBase();
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    async function setWorkStatus(state: PetWorkState, task?: string | null): Promise<void> {
        const body: Record<string, unknown> = { state };
        if (task !== undefined) body.task = task;
        const ok = await postJson(PET_PREFIX + '/work-status', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        setStatusBar(ok ? '小肥鱼：' + stateLabel(state) : '小肥鱼：未连接');
    }

    async function clearWorkStatus(): Promise<void> {
        const ok = await postJson(PET_PREFIX + '/work-status', { method: 'DELETE' });
        setStatusBar(ok ? '小肥鱼：空闲' : '小肥鱼：未连接');
    }

    function scheduleIdle(): void {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            void clearWorkStatus().catch((error: unknown) => {
                logger.warn('回空闲失败：' + (error instanceof Error ? error.message : String(error)));
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
        await postJson(PET_PREFIX + '/anim?pet=' + encodeURIComponent(petId), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
        });
    }

    const disposables = [
        events.on('chat.message.willSend', (input) => {
            if (!enabled()) return;
            cancelIdle();
            void setWorkStatus('working', taskFromMessage(input.content)).catch((error: unknown) => {
                logger.warn('推 working 失败：' + String(error));
            });
        }),
        events.on('tool.willExecute', (input) => {
            if (!enabled()) return;
            cancelIdle();
            void setWorkStatus('working').catch((error: unknown) => {
                logger.warn('推 working 失败：' + String(error));
            });
            logger.debug('工具开始：' + input.tool);
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
                    logger.warn('推 success 失败：' + String(error));
                });
            scheduleIdle();
        }),
        events.on('tool.onError', (input) => {
            if (!enabled()) return;
            void setWorkStatus('error', truncateTask('工具 ' + input.tool + ' 出错')).catch(
                (error: unknown) => {
                    logger.warn('推 error 失败：' + String(error));
                },
            );
            scheduleIdle();
        }),
        events.on('app.ready', () => {
            logger.info('小肥鱼桥接已就绪，开始找宠物宿主…');
            void resolveBase(true).then((base) => {
                if (!base) {
                    setStatusBar('小肥鱼：未连接');
                    logger.warn(
                        '没找到宠物：先让 DSH 桌面版（或 dsh-pet.exe）跑起来，再回插件设置点保存重连。',
                    );
                    return;
                }
                setStatusBar('小肥鱼：空闲');
                logger.info('宠物宿主：' + base);
            });
        }),
        events.on('app.willQuit', async () => {
            cancelIdle();
            await clearWorkStatus();
        }),
        settings.onDidChange((event) => {
            if (event.key === 'dshPetAlmaBridge.petBaseUrl') {
                forgetBase();
                logger.info('宠物地址改成 ' + String(event.newValue) + '，下次事件起重新探测');
            }
        }),
    ];

    logger.info('小肥鱼桥接插件已激活（v0.2，支持端口自动发现）');

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
