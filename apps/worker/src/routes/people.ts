// Hono routes for the People list (people/people.ts): friends and recent players, a name search,
// and starring a friend. GET / takes ?show=friends|recent for just one of the two.
import { Hono } from 'hono';
import { isBot } from '@fortytwo/rules';
import type { AppEnv } from '../index';
import { BadRequestError, peopleView, searchQuery, userIdParam } from '../requestBody';
import { SEARCH_MAX, SEARCH_MIN, addFriend, isKnownUser, listPeople, removeFriend, searchPeople } from '../people/people';

const people = new Hono<AppEnv>();

people.get('/', async (c) => c.json(await listPeople(c.env, c.get('user').sub, peopleView(c.req.query('show')))));

people.get('/search', async (c) => {
  const q = searchQuery(c.req.query('q'), SEARCH_MIN, SEARCH_MAX);
  return c.json(await searchPeople(c.env.DB, c.get('user').sub, q));
});

people.put('/friends/:userId', async (c) => {
  const userId = c.get('user').sub;
  const friendId = userIdParam(c.req.param('userId'));
  if (friendId === userId) throw new BadRequestError("You can't add yourself as a friend.");
  if (isBot(friendId)) throw new BadRequestError("Bots can't be friends.");
  if (!(await isKnownUser(c.env.DB, friendId))) return c.json({ title: 'Not found', detail: 'No player with that id.' }, 404);
  await addFriend(c.env.DB, userId, friendId);
  return c.body(null, 204);
});

people.delete('/friends/:userId', async (c) => {
  await removeFriend(c.env.DB, c.get('user').sub, userIdParam(c.req.param('userId')));
  return c.body(null, 204);
});

export default people;
