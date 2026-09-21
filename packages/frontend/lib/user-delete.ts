export function isActorIdConfirmed(value: string, actorId: string) {
  return value === actorId;
}

export const isActorDeletionConfirmed = isActorIdConfirmed;
