// common collections
// subscribed/fetched data acts as a mongo cache on the client
// some properties may not be sent to the client ofc.

import { Mongo } from 'meteor/mongo';

export const Rooms = new Mongo.Collection('room');
/*
  {
    roomName,
    passwordEnabled,
    password,
    users,
    createdAt
  }

*/

export default Rooms;
