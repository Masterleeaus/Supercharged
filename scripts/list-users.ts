import { db } from '../server/db';
import { users } from '../shared/schema';

async function main() {
  const allUsers = await db.select().from(users);
  console.log('Users in DB:');
  allUsers.forEach(u => {
    console.log(`- Email: ${u.email}, ID: ${u.id}, Role: ${u.role}`);
  });
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
