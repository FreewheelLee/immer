import {
	each,
	has,
	is,
	isDraftable,
	shallowCopy,
	latest,
	ImmerBaseState,
	ImmerState,
	Drafted,
	AnyObject,
	AnyArray,
	Objectish,
	getCurrentScope,
	DRAFT_STATE,
	die,
	createProxy,
	ProxyTypeProxyObject,
	ProxyTypeProxyArray
} from "../internal"

interface ProxyBaseState extends ImmerBaseState {
	assigned_: {
		[property: string]: boolean
	}
	parent_?: ImmerState
	revoke_(): void
}

export interface ProxyObjectState extends ProxyBaseState {
	type_: typeof ProxyTypeProxyObject
	base_: any
	copy_: any
	draft_: Drafted<AnyObject, ProxyObjectState>
}

export interface ProxyArrayState extends ProxyBaseState {
	type_: typeof ProxyTypeProxyArray
	base_: AnyArray
	copy_: AnyArray | null
	draft_: Drafted<AnyArray, ProxyArrayState>
}

type ProxyState = ProxyObjectState | ProxyArrayState

/**
 * Returns a new draft of the `base` object.
 *
 * The second argument is the parent draft-state (used internally).
 */
export function createProxyProxy<T extends Objectish>(
	base: T,
	parent?: ImmerState
): Drafted<T, ProxyState> {
	const isArray = Array.isArray(base)
	// state 是一个新建的简单对象，即将作为代理的目标 —— 注意代理的目标并不是 base ！
	const state: ProxyState = {
		type_: isArray ? ProxyTypeProxyArray : (ProxyTypeProxyObject as any), // type常量
		scope_: parent ? parent.scope_ : getCurrentScope()!, // scope用于跟踪是哪个produce调用产生了当前的proxy state
		modified_: false, // 是否修改过的标记标量
		finalized_: false, // 是否最终确定的标记标量
		assigned_: {}, // 记录哪些属性被新增或删减
		parent_: parent,
		base_: base, // 存放着原始值
		// The base proxy.
		draft_: null as any, // set below
		copy_: null, // base 的复制品，实际更新操作都会在 copy_ 上发现
		revoke_: null as any, // 存放 Proxy.revocable() 的 revoke 方法引用 参考 https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/revocable
		isManual_: false
	}

	// the traps must target something, a bit like the 'real' base.
	// but also, we need to be able to determine from the target what the relevant state is
	// (to avoid creating traps per instance to capture the state in closure,
	// and to avoid creating weird hidden properties as well)
	// So the trick is to use 'state' as the actual 'target'! (and make sure we intercept everything)
	// Note that in the case of an array, we put the state in an array to have better Reflect defaults ootb
	let target: T = state as any
	let traps: ProxyHandler<object | Array<any>> = objectTraps // 简单对象对应的 Proxy handler traps
	if (isArray) {
		target = [state] as any
		traps = arrayTraps // 数组对应的 Proxy handler traps
	}

	// 使用 traps 生成一个 revocable Proxy —— https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/revocable
	const {revoke, proxy} = Proxy.revocable(target, traps)
	state.draft_ = proxy as any
	state.revoke_ = revoke
	return proxy as any
}

/**
 * Object drafts
 */
export const objectTraps: ProxyHandler<ProxyState> = {
	get(state, prop) {
		if (prop === DRAFT_STATE) return state // DRAFT_STATE 是个预定义好的Symbol, state[DRAFT_STATE]指向自身

		const source = latest(state) // latest 中的实现将优先返回state.copy_，如果state.copy_不存在则返回state.base_
		if (!has(source, prop)) {
			// 从原型链上查找并读取non-own的属性
			return readPropFromProto(state, source, prop)
		}
		const value = source[prop]
		// 如果draft已经finalized，或者这个属性值不能被草稿化（比如 数字、字符串、布尔值），就直接返回
		if (state.finalized_ || !isDraftable(value)) {
			return value
		}

		// peek 函数直接获取对象属性值（不产生任何draft）
		// 如果对比发现相等，说明这个属性值还没有产生过proxy
		if (value === peek(state.base_, prop)) {
			prepareCopy(state) // 产生一个浅拷贝并赋值给 state.copy_
			return (state.copy_![prop as any] = createProxy(
				// 为属性值产生一个新的代理
				state.scope_.immer_,
				value,
				state
			))
		}
		return value
	},
	has(state, prop) {
		return prop in latest(state)
	},
	ownKeys(state) {
		return Reflect.ownKeys(latest(state))
	},
	set(
		state: ProxyObjectState,
		prop: string /* strictly not, but helps TS */,
		value
	) {
		const desc = getDescriptorFromProto(latest(state), prop)
		if (desc?.set) {
			// 如果有 setter
			// special case: if this write is captured by a setter, we have
			// to trigger it with the correct context
			desc.set.call(state.draft_, value)
			return true
		}
		if (!state.modified_) {
			const current = peek(latest(state), prop)

			const currentState: ProxyObjectState = current?.[DRAFT_STATE]
			if (currentState && currentState.base_ === value) {
				// 如果新值与原值相同，则视为没做改变
				state.copy_![prop] = value
				state.assigned_[prop] = false
				return true
			}
			if (is(value, current) && (value !== undefined || has(state.base_, prop)))
				return true
			prepareCopy(state) // 产生一个浅拷贝并赋值给 state.copy_
			markChanged(state) // 将 modified_ 设为 true（递归地给 parent state 都设置了）
		}

		if (state.copy_![prop] === value && typeof value !== "number") return true

		// @ts-ignore
		state.copy_![prop] = value // 赋值在 copy_ 上
		state.assigned_[prop] = true // 通过 assigned_ 来标记这个属性被新增
		return true
	},
	deleteProperty(state, prop: string) {
		// The `undefined` check is a fast path for pre-existing keys.
		if (peek(state.base_, prop) !== undefined || prop in state.base_) {
			state.assigned_[prop] = false // 标记为这个属性被删除
			prepareCopy(state)
			markChanged(state)
		} else {
			// 如果原本就不存在的一个属性被新增后又被删除，那么只需要删除 assigned_ 中的记录就行
			delete state.assigned_[prop]
		}
		// @ts-ignore
		if (state.copy_) delete state.copy_[prop] // 从 copy_ 上删除这个属性
		return true
	},
	// Note: We never coerce `desc.value` into an Immer draft, because we can't make
	// the same guarantee in ES5 mode.
	getOwnPropertyDescriptor(state, prop) {
		const owner = latest(state)
		const desc = Reflect.getOwnPropertyDescriptor(owner, prop)
		if (!desc) return desc
		return {
			writable: true,
			configurable: state.type_ !== ProxyTypeProxyArray || prop !== "length",
			enumerable: desc.enumerable,
			value: owner[prop]
		}
	},
	defineProperty() {
		die(11)
	},
	getPrototypeOf(state) {
		return Object.getPrototypeOf(state.base_)
	},
	setPrototypeOf() {
		die(12)
	}
}

/**
 * Array drafts
 */

const arrayTraps: ProxyHandler<[ProxyArrayState]> = {}
each(objectTraps, (key, fn) => {
	// @ts-ignore
	arrayTraps[key] = function() {
		arguments[0] = arguments[0][0]
		return fn.apply(this, arguments)
	}
})
arrayTraps.deleteProperty = function(state, prop) {
	if (__DEV__ && isNaN(parseInt(prop as any))) die(13)
	return objectTraps.deleteProperty!.call(this, state[0], prop)
}
arrayTraps.set = function(state, prop, value) {
	if (__DEV__ && prop !== "length" && isNaN(parseInt(prop as any))) die(14)
	return objectTraps.set!.call(this, state[0], prop, value, state[0])
}

// Access a property without creating an Immer draft.
function peek(draft: Drafted, prop: PropertyKey) {
	const state = draft[DRAFT_STATE]
	const source = state ? latest(state) : draft
	return source[prop]
}

function readPropFromProto(state: ImmerState, source: any, prop: PropertyKey) {
	const desc = getDescriptorFromProto(source, prop)
	return desc
		? `value` in desc
			? desc.value
			: // This is a very special case, if the prop is a getter defined by the
			  // prototype, we should invoke it with the draft as context!
			  desc.get?.call(state.draft_)
		: undefined
}

function getDescriptorFromProto(
	source: any,
	prop: PropertyKey
): PropertyDescriptor | undefined {
	// 'in' checks proto!
	if (!(prop in source)) return undefined
	let proto = Object.getPrototypeOf(source)
	while (proto) {
		const desc = Object.getOwnPropertyDescriptor(proto, prop)
		if (desc) return desc
		proto = Object.getPrototypeOf(proto)
	}
	return undefined
}

export function markChanged(state: ImmerState) {
	if (!state.modified_) {
		state.modified_ = true
		if (state.parent_) {
			markChanged(state.parent_)
		}
	}
}

export function prepareCopy(state: {base_: any; copy_: any}) {
	if (!state.copy_) {
		state.copy_ = shallowCopy(state.base_)
	}
}
