export class ImportBillingDto {
  monthKey: string;
  provider: string;
}

export class ConfirmBillingDto {
  monthKey: string;
  provider: string;
  userId: string;
}
