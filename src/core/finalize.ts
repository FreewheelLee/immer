import {
	ImmerScope,
	DRAFT_STATE,
	isDraftable,
	NOTHING,
	PatchPath,
	each,
	has,
	freeze,
	ImmerState,
	isDraft,
	SetState,
	set,
	ProxyTypeES5Object,
	ProxyTypeES5Array,
	ProxyTypeSet,
	getPlugin,
	die,
	revokeScope,
	isFrozen,
	shallowCopy
} from "../internal"

export function processResult(result: any, scope: ImmerScope) {
	scope.unfinalizedDrafts_ = scope.drafts_.length
	const baseDraft = scope.drafts_![0]
	const isReplaced = result !== undefined && result !== baseDraft
	if (!scope.immer_.useProxies_)
		getPlugin("ES5").willFinalizeES5_(scope, result, isReplaced)
	if (isReplaced) {
		// 这种情况是针对异步recipe的，不作详细解读。https://github.com/immerjs/immer/blob/e0b7c01c4ce039b7a68b5cb3cd97a7242962b7ab/src/core/immerClass.ts#L105
		if (baseDraft[DRAFT_STATE].modified_) {
			revokeScope(scope)
			die(4)
		}
		if (isDraftable(result)) {
			// Finalize the result in case it contains (or is) a subset of the draft.
			result = finalize(scope, result)
			if (!scope.parent_) maybeFreeze(scope, result)
		}
		if (scope.patches_) {
			getPlugin("Patches").generateReplacementPatches_(
				baseDraft[DRAFT_STATE],
				result,
				scope.patches_,
				scope.inversePatches_!
			)
		}
	} else {
		// Finalize the base draft.  最终确定草稿，得到结果
		result = finalize(scope, baseDraft, [])
	}
	revokeScope(scope) // revoke 当前 scope
	if (scope.patches_) {
		scope.patchListener_!(scope.patches_, scope.inversePatches_!)
	}
	return result !== NOTHING ? result : undefined
}

// 主要做两件事：1. 结束draft的生命 2. 冻结对象（看配置）
function finalize(rootScope: ImmerScope, value: any, path?: PatchPath) {
	// Don't recurse in tho recursive data structures
	if (isFrozen(value)) return value

	// 只有draft有DRAFT_STATE属性 参考 https://github.com/immerjs/immer/blob/e0b7c01c4ce039b7a68b5cb3cd97a7242962b7ab/src/core/proxy.ts#L103
	const state: ImmerState = value[DRAFT_STATE]
	// A plain object, might need freezing, might contain drafts
	// 如果state是undefined，那么说明这是个简单对象 —— 简单对象里的属性可能也有draft，可能需要冻结
	if (!state) {
		// 遍历目标对象的所有属性，然后finalize
		each(
			value,
			(key, childValue) =>
				finalizeProperty(rootScope, state, value, key, childValue, path),
			true // See #590, don't recurse into non-enumarable of non drafted objects
		)
		return value
	}
	// Never finalize drafts owned by another scope.
	// 不处理不属于当前scope的draft
	if (state.scope_ !== rootScope) return value
	// Unmodified draft, return the (frozen) original
	// 如果draft完全没被修改过，直接返回原值就好了
	if (!state.modified_) {
		maybeFreeze(rootScope, state.base_, true) // 根据配置可选地冻结
		return state.base_
	}
	// Not finalized yet, let's do that now
	// 如果 draft 被修改过，且还没被 finalize
	if (!state.finalized_) {
		state.finalized_ = true // 设标志位
		state.scope_.unfinalizedDrafts_--
		const result =
			// For ES5, create a good copy from the draft first, with added keys and without deleted keys.
			// 对 es5 有特别的处理，本文不做详细分析
			// 对其他类型，使用 state.copy_  参考https://github.com/immerjs/immer/blob/e0b7c01c4ce039b7a68b5cb3cd97a7242962b7ab/src/core/proxy.ts#L269
			state.type_ === ProxyTypeES5Object || state.type_ === ProxyTypeES5Array
				? (state.copy_ = shallowCopy(state.draft_))
				: state.copy_
		// 对 Set 有特别的处理，本文不做详细分析
		// 对其他类型，遍历目标对象的所有属性，然后finalize
		each(
			state.type_ === ProxyTypeSet ? new Set(result) : result,
			(key, childValue) =>
				finalizeProperty(rootScope, state, result, key, childValue, path)
		)
		// 根据配置可选地冻结
		maybeFreeze(rootScope, result, false)
		// 生成 patches，本文不做详细分析
		if (path && rootScope.patches_) {
			getPlugin("Patches").generatePatches_(
				state,
				path,
				rootScope.patches_,
				rootScope.inversePatches_!
			)
		}
	}
	return state.copy_ // 返回 state.copy_ 里存放的对象
}

function finalizeProperty(
	rootScope: ImmerScope,
	parentState: undefined | ImmerState,
	targetObject: any,
	prop: string | number,
	childValue: any,
	rootPath?: PatchPath
) {
	if (__DEV__ && childValue === targetObject) die(5)
	if (isDraft(childValue)) {
		// 如果属性值也是个 draft
		const path = // path 是跟 patches 相关的参数，这边不做详细分析
			rootPath &&
			parentState &&
			parentState!.type_ !== ProxyTypeSet && // Set objects are atomic since they have no keys.
			!has((parentState as Exclude<ImmerState, SetState>).assigned_!, prop) // Skip deep patches for assigned keys.
				? rootPath!.concat(prop)
				: undefined
		// 递归地调用 finalize，对属性值也做 finalize 处理
		const res = finalize(rootScope, childValue, path)
		// 注意这边 targetObject 要么是简单对象，要么就是前面的 state.copy_ 而不再是 proxy
		set(targetObject, prop, res)
		// Drafts from another scope must prevented to be frozen
		// if we got a draft back from finalize, we're in a nested produce and shouldn't freeze
		if (isDraft(res)) {
			rootScope.canAutoFreeze_ = false
		} else return
	}
	// 如果子属性值是 Draftable 的（比如 简单对象，数组，Set，Map 等）
	if (isDraftable(childValue) && !isFrozen(childValue)) {
		if (!rootScope.immer_.autoFreeze_ && rootScope.unfinalizedDrafts_ < 1) {
			// 性能优化处理
			// optimization: if an object is not a draft, and we don't have to
			// deepfreeze everything, and we are sure that no drafts are left in the remaining object
			// cause we saw and finalized all drafts already; we can stop visiting the rest of the tree.
			// This benefits especially adding large data tree's without further processing.
			// See add-data.js perf test
			return
		}
		// 递归地调用 finalize，对属性值也做 finalize 处理
		finalize(rootScope, childValue)
		// immer deep freezes plain objects, so if there is no parent state, we freeze as well
		if (!parentState || !parentState.scope_.parent_)
			maybeFreeze(rootScope, childValue)
	}
	// 如果子属性值是不可 Draftable 的（比如 boolean, number, string 等），就什么也不做
}

function maybeFreeze(scope: ImmerScope, value: any, deep = false) {
	// 根据配置项 autoFreeze_ 和 canAutoFreeze_ 决定要不要冻结目标对象
	if (scope.immer_.autoFreeze_ && scope.canAutoFreeze_) {
		freeze(value, deep)
	}
}
