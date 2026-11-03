export interface IntegrationSummary {

  addHeading(text: string): IntegrationSummary;
  addList(items: string[]): IntegrationSummary;
  addRaw(text: string): IntegrationSummary;
  write(): Promise<unknown>;
}

export interface IntegrationCore {

  info(message: string): void;
  warning(message: string): void;
  error(error: string | Error): void;
  summary: IntegrationSummary;
}
