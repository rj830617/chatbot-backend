import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEMO_USERS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Alice' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Bob' },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Carol' },
];

async function main(): Promise<void> {
  for (const user of DEMO_USERS) {
    await prisma.user.upsert({ where: { id: user.id }, update: {}, create: user });
  }
  console.log('Seeded users:');
  console.table(DEMO_USERS);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
