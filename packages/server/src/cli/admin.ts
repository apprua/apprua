#!/usr/bin/env node
// Emergency admin commands, run inside the Apprua container, e.g.
//   node dist/src/cli/admin.js token <email> [--admin]      issue a personal token (printed once)
//   node dist/src/cli/admin.js password <email> <password>  set a new password (local accounts)
//   node dist/src/cli/admin.js revoke <email>
//   node dist/src/cli/admin.js new-password [email]      a new random password, printed once (no email: the only administrator)
//   node dist/src/cli/admin.js users
//   node dist/src/cli/admin.js forget <email>            remove an account on request; its email leaves the history
import { issueToken, randomPassword, revokeToken, setPassword } from '../auth.js';
import { getDb, getUser, openDb, upsertUser } from '../db.js';
import { forgetUser } from '../forget.js';
import { config } from '../config.js';

openDb();
const [cmd, email, arg] = process.argv.slice(2);
switch (cmd) {
  case 'token': {
    if (!email) throw new Error('usage: token <email> [--admin]');
    const existing = getUser(email);
    upsertUser(email, null, arg === '--admin' ? 'admin' : existing?.role ?? 'user');
    const { token, expiresAt } = issueToken(email.toLowerCase(), 'cli');
    console.log(`token for ${email} (expires ${expiresAt.slice(0, 10)}):\n${token}`);
    break;
  }
  case 'password': {
    if (!email || !arg) throw new Error('usage: password <email> <new password>');
    if (!getUser(email)) throw new Error(`unknown user ${email}`);
    setPassword(email.toLowerCase(), arg, 'cli');
    console.log(`password changed for ${email}`);
    break;
  }
  case 'new-password': {
    // install/reset-password.sh (Linux) and install-apprua.ps1 -ResetPassword (Windows) call this
    let who = email?.toLowerCase();
    if (!who) {
      const admins = getDb().prepare("SELECT email FROM users WHERE role = 'admin' AND password_hash IS NOT NULL AND disabled_at IS NULL ORDER BY email").all() as { email: string }[];
      if (admins.length !== 1) {
        console.log('Which account? Run the command again with its email. The accounts are:');
        for (const u of getDb().prepare('SELECT email, role FROM users ORDER BY email').all() as { email: string; role: string }[]) console.log(`  ${u.email}  (${u.role})`);
        process.exit(2);
      }
      who = admins[0].email;
    }
    if (!getUser(who)) { console.log(`There is no account ${who}.`); process.exit(2); }
    const pw = randomPassword();
    setPassword(who, pw, 'cli');
    console.log(`New password for ${who}:

    ${pw}

Sign in with it, then change it in "Your account". Every device signed in with the old one has to sign in again.`);
    break;
  }
  case 'revoke':
    revokeToken(email.toLowerCase(), 'cli');
    console.log(`revoked ${email}`);
    break;
  case 'users':
    console.table(getDb().prepare('SELECT email, role, token_prefix, token_expires_at, revoked_at, disabled_at FROM users').all());
    break;
  case 'forget': {
    if (!email) { console.log('usage: forget <email>'); process.exit(2); }
    try {
      const r = forgetUser(email);
      console.log(`Account ${r.removed} removed. In the history of Apprua its email is now the random label "${r.label}"
(the rest of the history, such as IP addresses of failed sign-ins, stays as it is).
Still to do by hand, if they apply: the copies made before today (they keep the account until they are replaced),
and the history of versions inside the code archive of each app this person published (it keeps their name and email).`);
      if (config.auth.mode === 'proxy')
        console.log(`Sign-in goes through a login proxy here: remove ${r.removed} from the identity system too, or Apprua creates the account again at their next sign-in.`);
    } catch (e) { console.log((e as Error).message); process.exit(2); }
    break;
  }
  default:
    console.log('commands: token <email> [--admin] | password <email> <new password> | new-password [email] | revoke <email> | users | forget <email>');
}
