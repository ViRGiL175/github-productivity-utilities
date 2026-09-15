export interface Logger {
  info(message: string): void;
  warning(message: string): void;
}

export class ConsoleLogger implements Logger {
  info(message: string): void {
    console.log(message);
  }

  warning(message: string): void {
    console.warn(message);
  }
}
