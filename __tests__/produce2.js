import {_, assert} from "spec.ts"
import produce, {Draft, enableAllPlugins, isDraftable} from "../src/immer"

enableAllPlugins()

// interface State {
// 	readonly num: number
// 	readonly foo?: string
// 	bar: string
// 	readonly baz: {
// 		readonly x: number
// 		readonly y: number
// 	}
// 	readonly arr: ReadonlyArray<{readonly value: string}>
// 	readonly arr2: {readonly value: string}[]
// }

const expectedState = [
	{name: "tom", id: 0},
	{name: "jerry", id: 1},
	{name: "kitty", id: 2}
]

it("can update readonly state via curried api", () => {
	const state = [{name: "tom"}, {name: "jerry"}, {name: "kitty"}]

	let mapper = produce((draft, index) => {
		draft.id = index
	})
	const res = mapper({name: "hi"})
	console.log("res " + JSON.stringify(res))
	const newState = state.map(mapper)
	expect(newState).not.toBe(state)
	expect(newState).toEqual(expectedState)

	console.log("isDraftable(1) " + isDraftable(1))
	console.log("isDraftable(true) " + isDraftable(true))
	console.log("isDraftable(false) " + isDraftable(false))
	console.log("isDraftable(hello) " + isDraftable("hello"))

	const baseState = [
		{
			todo: "Learn typescript",
			done: true
		},
		{
			todo: "Try immer",
			done: false
		}
	]

	const nextState = produce(baseState, draftState => {
		draftState.push({todo: "Tweet about it"})
		draftState[1].done = true
	})
	console.log(JSON.stringify(nextState, null, 2))
})
