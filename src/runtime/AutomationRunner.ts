export interface Automation {
  run(): Promise<void>;
}

export class AutomationRunner {
  constructor(private readonly automations: ReadonlyMap<string, Automation>) {}

  async run(name: string): Promise<void> {
    const automation = this.automations.get(name);
    if (!automation) {
      throw new Error(`Unsupported automation: ${name}`);
    }

    await automation.run();
  }
}
