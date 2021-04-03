import {
	Patch,
	PatchListener,
	Drafted,
	Immer,
	DRAFT_STATE,
	ImmerState,
	ProxyTypeProxyObject,
	ProxyTypeProxyArray,
	getPlugin
} from "../internal"
import {die} from "../utils/errors"

/** Each scope represents a `produce` call. */
// 每一个 scope 都代表了一次 produce 调用

export interface ImmerScope {
	patches_?: Patch[]
	inversePatches_?: Patch[]
	canAutoFreeze_: boolean
	drafts_: any[]
	parent_?: ImmerScope
	patchListener_?: PatchListener
	immer_: Immer
	unfinalizedDrafts_: number
}
// 模块层面的变量 —— 因此是个单例
let currentScope: ImmerScope | undefined

export function getCurrentScope() {
	if (__DEV__ && !currentScope) die(0)
	return currentScope!
}

function createScope(
	parent_: ImmerScope | undefined,
	immer_: Immer
): ImmerScope {
	// scope 的数据结构
	return {
		drafts_: [], // 维护着一个 draft 数组, 每次 createProxy 时都会往该数组中新增一个 draft。 https://github.com/immerjs/immer/blob/e0b7c01c4ce039b7a68b5cb3cd97a7242962b7ab/src/core/immerClass.ts#L227
		parent_, // 可以理解为单链表，parent_是个指向 parent scope 的引用
		immer_,
		canAutoFreeze_: true,
		unfinalizedDrafts_: 0
	}
}

export function usePatchesInScope(
	scope: ImmerScope,
	patchListener?: PatchListener
) {
	if (patchListener) {
		getPlugin("Patches") // assert we have the plugin
		scope.patches_ = []
		scope.inversePatches_ = []
		scope.patchListener_ = patchListener
	}
}

export function revokeScope(scope: ImmerScope) {
	leaveScope(scope) // rovoke 之前还是需要先 leave
	scope.drafts_.forEach(revokeDraft) // 对 scope 中的所有drafts 执行revokeDraft
	// @ts-ignore
	scope.drafts_ = null
}

export function leaveScope(scope: ImmerScope) {
	if (scope === currentScope) {
		currentScope = scope.parent_ // 将currentScope指向 parent_
	}
}

export function enterScope(immer: Immer) {
	// 创建新scope并且将currentScope变量更新
	return (currentScope = createScope(currentScope, immer))
}

function revokeDraft(draft: Drafted) {
	const state: ImmerState = draft[DRAFT_STATE] // 从 draft 的 symbol属性 DRAFT_STATE 中获得内部状态对象
	if (
		state.type_ === ProxyTypeProxyObject ||
		state.type_ === ProxyTypeProxyArray
	)
		// 调用 revoke_ 实际上调用的是Proxy.revocable() 返回的 revoke 方法，
		// 参考 https://github.com/immerjs/immer/blob/e0b7c01c4ce039b7a68b5cb3cd97a7242962b7ab/src/core/proxy.ts#L92 以及之后两行代码
		state.revoke_()
	else state.revoked_ = true // 记录状态
}
