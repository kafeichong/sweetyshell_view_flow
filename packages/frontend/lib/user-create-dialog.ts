export interface UserCreateDialogState {
  phase: 'form' | 'success'
  draft: { actorId: string; name: string }
  token: string | null
  copied: boolean
}

export type UserCreateDialogAction =
  | { type: 'updateDraft'; field: 'actorId' | 'name'; value: string }
  | { type: 'created'; token: string }
  | { type: 'copied' }
  | { type: 'reset' }

export function createInitialUserDialogState(): UserCreateDialogState {
  return {
    phase: 'form',
    draft: { actorId: '', name: '' },
    token: null,
    copied: false,
  }
}

export function userDialogReducer(
  state: UserCreateDialogState,
  action: UserCreateDialogAction,
): UserCreateDialogState {
  switch (action.type) {
    case 'updateDraft':
      return {
        ...state,
        draft: { ...state.draft, [action.field]: action.value },
      }
    case 'created':
      return {
        phase: 'success',
        draft: { actorId: '', name: '' },
        token: action.token,
        copied: false,
      }
    case 'copied':
      return { ...state, copied: true }
    case 'reset':
      return createInitialUserDialogState()
  }
}
