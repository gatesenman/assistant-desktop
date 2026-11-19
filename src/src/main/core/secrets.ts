/** API Key 加解密接口（主进程中由 Electron safeStorage 实现，测试中可替换） */
export interface SecretCodec {
  available(): boolean
  backend(): string
  encrypt(plain: string): string
  decrypt(enc: string): string
}

/** 不加密的回退实现（仅当系统加密不可用时使用） */
export const plainCodec: SecretCodec = {
  available: () => false,
  backend: () => 'none',
  encrypt: (s) => s,
  decrypt: (s) => s
}
