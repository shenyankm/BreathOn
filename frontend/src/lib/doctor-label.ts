export function doctorLabel(name: string): string {
  return name.replace(/\s*[（(]\s*训练模拟\s*[）)]\s*$/, '')
}
