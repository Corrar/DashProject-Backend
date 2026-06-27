import bcrypt from 'bcryptjs';
import { HttpError } from '../lib';

const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
export function assertStrongPassword(pw: string): void {
  if (typeof pw !== 'string' || pw.length < 8) {
    throw new HttpError(400, 'senha_fraca', 'A senha precisa ter ao menos 8 caracteres.');
  }
}
