/* global location window Erizo URL*/
import { Meteor } from 'meteor/meteor';

import React, { Component } from 'react';
import { connect } from 'react-redux';
import update from 'immutability-helper';
import _ from 'lodash';

// import Erizo from '../../modules/Erizo';

import hark from 'hark';

// constants
import uiConfig from '../../components/room/constants/uiConfig';
import status from '../../components/room/constants/status';
import streamTypes from '../../components/room/constants/streamType';
import roomActivities from '../../components/room/constants/roomActivities';

// room components
import StreamsContainer from '../../components/room/StreamsContainer/';
import Spotlight from '../../components/room/Spotlight';

import ActivityListener from '../../../modules/ActivityListener';
import RoomAPI from './RoomAPI';
import Messenger from './Messenger';
import StreamManager from './StreamManager';

import messageType from '../../components/room/constants/messageType';

import { MEDIASTREAMS_RESET, MEDIASTREAMS_UPDATE } from '../../actions/mediaStreams';
import { SPEAKING, SPEAKING_STOPPED } from '../../actions/stream';

import './room.scss';

const roomMessageTypes = {
  SPEECH: 'SPEECH',
  STREAM_SUBSCRIBE_SUCCESS: 'STREAM_SUBSCRIBE_SUCCESS',
};

class Room extends Component {

  constructor(props) {
    super(props);
    this.roomName = props.roomInfo.roomName;
    this.erizoToken = localStorage.getItem(`erizoToken:${this.roomName}`);

    // subscribed incoming data streams
    this.subscribedDataStreams = {}; // streamId -> erizoStream

    this.subscribedMediaStreams = {}; // streamId -> erizoStream
    // note: erizoStream.stream would be of type MediaStream(the browser's MediaStream object)
    this.speechTrackers = {}; // id -> hark instance

    this.messageHandler = this.messageHandler.bind(this);
    // for passing messages to and from tabs | local or remote(other users)
    this.messenger = new Messenger(this, this.messageHandler);

    // Listens for activities in the room, such as user entering, leaving etc.
    // not naming it roomEvent because that naming is used in the Erizo room.
    this.activityListener = new ActivityListener(roomActivities);

    this.streamManager = new StreamManager(this);

    this.roomAPI = new RoomAPI(this);

    this.applyRoomPreferences = this.applyRoomPreferences.bind(this);
    this.calculateUISize = this.calculateUISize.bind(this);
    this.onWindowResize = _.throttle(this.onWindowResize, 100);
    this.onWindowResize = this.onWindowResize.bind(this);

    this.updateState = this.updateState.bind(this);
    this.tryToConnect = this.tryToConnect.bind(this);
    this.setRoomConnectionListeners = this.setRoomConnectionListeners.bind(this);
    this.setRoomStreamListners = this.setRoomStreamListners.bind(this);
    this.connectUser = this.connectUser.bind(this);
    this.disconnectUser = this.disconnectUser.bind(this);
    // not all of these need to be bound, doing so anyway as I
    // often end up moving them around and getting stuck with the same error for a while.

    this.setDataBroadcastStreamListners = this.setDataBroadcastStreamListners.bind(this);
    this.handleStreamSubscription = this.handleStreamSubscription.bind(this);
    this.setIncomingStreamListners = this.setIncomingStreamListners.bind(this);
    this.handleStreamRemoval = this.handleStreamRemoval.bind(this);
    this.handleStreamSubscriptionSucess = this.handleStreamSubscriptionSucess.bind(this);
    this.incrementVideoStreamCount = this.incrementVideoStreamCount.bind(this);
    this.decrementVideoStreamCount = this.decrementVideoStreamCount.bind(this);
    this.determineStreamContainerSize = this.determineStreamContainerSize.bind(this);
    this.setCustomStreamContainerSize = this.setCustomStreamContainerSize.bind(this);

    this.state = {
      connectionTable: {},
      connectedUsers: [],

      roomConnectionStatus: status.INITIALIZING,
      dataBroadcastStreamStatus: status.TRYING_TO_CONNECT,
      primaryMediaStreamStatus: status.TRYING_TO_CONNECT,

      customStreamContainerSize: false,
      videoStreamCount: 0,

      uiSize: this.calculateUISize(),
      roomHeight: innerHeight,
      roomWidth: innerWidth,


      settings: {
        uiBreakRatio: uiConfig.defaultBreakRatio,
        uiBreakWidth: uiConfig.defaultBreakWidth,
      }, // user preferences such as room component sizes, position etc.
    };
    this.stateBuffer = this.state;
    this.unmountInProgress = false;
  }

  updateState(changes, buffer = this.stateBuffer) {
    this.stateBuffer = update(buffer, changes);
    this.setState(this.stateBuffer);
  }

  calculateUISize() {
    const { innerWidth, innerHeight } = window;
    let breakWidth = uiConfig.defaultBreakWidth;
    let breakRatio = uiConfig.defaultBreakRatio;

    if (this.state) { // component has initialized
      const settings = this.state.settings;
      breakRatio = settings.uiBreakRatio;
      breakWidth = settings.uiBreakWidth;
    }

    if (innerWidth < breakWidth) {
      return uiConfig.COMPACT;
    }
    const ratio = innerWidth / innerHeight;
    return ratio < breakRatio ? uiConfig.COMPACT : uiConfig.LARGE;
  }

  applyRoomPreferences() {
    // override room settings with user's preferences if any
  }

  tryToConnect() {
    if (this.stateBuffer.roomConnectionStatus === status.TRYING_TO_CONNECT
        || this.unmountInProgress) {
      return;
    }
    const connectToErizo = (erizoToken, recievedNewToken = false) => {
      if (recievedNewToken) {
        console.info('got a new token');
      }
      console.info('trying to connect');
      this.updateState({ roomConnectionStatus: { $set: status.TRYING_TO_CONNECT } });
      this.erizoToken = erizoToken;
      /* eslint-disable new-cap */
      this.sessionId = _.random(5000);
      this.erizoRoom = Erizo.Room({ token: this.erizoToken });
      // an erizo data stream to be used for sending 'data' by this user
      this.dataBroadcastStream = Erizo.Stream({
        data: true,
        attributes: {
          userId: this.props.roomUserId,
          sessionId: this.sessionId,
          type: streamTypes.DATA.BROADCAST,
        },
      });
      this.setDataBroadcastStreamListners();
      this.dataBroadcastStream.init();
      /* eslint-enable new-cap */
      this.setRoomConnectionListeners();
      this.setRoomStreamListners();
      this.erizoRoom.connect();
    };

    if (this.stateBuffer.roomConnectionStatus === status.INITIALIZING) {
      connectToErizo(this.erizoToken);
      return;
    }

    this.props.joinRoom(this.props.roomInfo._id)
      .then(({ erizoToken }) => {
        connectToErizo(erizoToken, true);
      })
      .catch(() => { location.reload(); });
  }

  setRoomConnectionListeners(erizoRoom = this.erizoRoom) {
    erizoRoom.addEventListener('room-connected', (roomEvent) => {
      console.info('room connected', roomEvent, erizoRoom);
      erizoRoom.publish(this.dataBroadcastStream);
      this.updateState({ roomConnectionStatus: { $set: status.CONNECTED } });
    });

    erizoRoom.addEventListener('room-error', (roomEvent) => {
      console.error('room connection error', roomEvent);
      this.updateState({ roomConnectionStatus: { $set: status.ERROR } });
    });

    erizoRoom.addEventListener('room-disconnected', (roomEvent) => {
      console.info('room disconnected', roomEvent);
      this.stateBuffer.connectedUsers.forEach((user) => {
        let sessionCount = user.sessionCount;
        while (sessionCount--) {
          this.disconnectUser(user);
        }
        console.info('disconnected user', user);
      });
      this.updateState({
        roomConnectionStatus: { $set: status.DISCONNECTED },
        dataBroadcastStreamStatus: { $set: status.TRYING_TO_CONNECT },
        connectedUsers: { $set: [] },
      });
      this.dataBroadcastStream.stop();
      this.props.resetMediaStreams();
      this.subscribedDataStreams = {};
      this.subscribedMediaStreams = {};

      // stop speechTrackers
      Object.keys(this.speechTrackers).forEach(streamId => this.speechTrackers[streamId].stop());
      this.speechTrackers = {};
      setTimeout(() => {
        this.tryToConnect();
      }, 1000);
    });
  }

  setRoomStreamListners(erizoRoom = this.erizoRoom) {
    // when streams are added_to/removed_from the room
    erizoRoom.addEventListener('stream-added', (streamEvent) => {
      const { stream } = streamEvent;
      this.handleStreamSubscription(stream);
      console.info('stream added', streamEvent, streamEvent.stream.getAttributes());
    });

    erizoRoom.addEventListener('stream-subscribed', (streamEvent) => {
      console.info('stream subscribed', streamEvent, streamEvent.stream.getAttributes());
      this.handleStreamSubscriptionSucess(streamEvent.stream);
    });
    // I don't know whether a failed stream would trigger a stream-removed later
    // need to keep this in mind for later
    erizoRoom.addEventListener('stream-failed', (streamEvent) => {
      // so far none of the streams have failed. however it will definitely
      // be more likely in deployements
      console.error('Oi! stream failed', streamEvent, streamEvent.stream.getAttributes());
      // debugger
      // this.handleStreamRemoval(streamEvent.stream);
    });

    erizoRoom.addEventListener('stream-removed', (streamEvent) => {
      console.info('stream removed', streamEvent, streamEvent.stream.getAttributes());
      this.handleStreamRemoval(streamEvent.stream);
    });
  }

  setDataBroadcastStreamListners() {
    const stream = this.dataBroadcastStream;
    stream.addEventListener('access-accepted', (streamEvent) => {
      console.info('dataBroadcastStream access-accepted', streamEvent);
    });
    stream.addEventListener('access-denied', (streamEvent) => {
      console.error('dataBroadcastStream access-denied', streamEvent);
    });
  }

  initializePrimaryMediaStream() {
    if (this.primaryMediaStream) {
      // unpublish and destroy
    }
    // get config and initialize new stream
    // assume this config for now.
    this.primaryMediaStream = Erizo.Stream({
      audio: true,
      video: true,
      data: false,
      attributes: {
        userId: this.props.roomUserId,
        type: streamTypes.PRIMARY_MEDIA_STREAM,
      },
    });
    const mediaStream = this.primaryMediaStream;
    mediaStream.addEventListener('access-accepted', () => {
      this.erizoRoom.publish(mediaStream);
    });
    mediaStream.addEventListener('access-denied', () => {
      this.updateState({
        primaryMediaStream: { $set: status.ERROR },
      });
    });
    mediaStream.addEventListener('stream-ended', () => {
      this.updateState({
        primaryMediaStream: { $set: status.DISCONNECTED },
      });
    });
    mediaStream.init();
  }

  handleStreamSubscription(stream) {
    const attributes = stream.getAttributes();
    const user = _.find(this.props.roomInfo.participants, { userId: attributes.userId });
    if (!user) throw new Meteor.Error('stream publisher not found');

    const { DATA, PRIMARY_MEDIA_STREAM, MEDIA_STREAM } = streamTypes;

    const subscribeDataBroadcastStream = () => {
      // just a check If I run into this later
      if (this.subscribedDataStreams[stream.getID()]) { // stream already subscribed
        throw new Meteor.Error('over here!');
      }
      if (this.streamManager.isLocalStream(stream)) {
        // do not subscribe our own data stream.
        this.updateState({ dataBroadcastStreamStatus: { $set: status.CONNECTED } });
        console.info('dataBroadcastStream successfully added to the room.');
        this.connectUser(user);
        // this.initializePrimaryMediaStream();

        // subscribe all remote data broadcast stream prexisting streams in the room
        console.info('subscribing all remote data broadcast stream prexisting streams in the room');
        const currentStreamId = stream.getID();
        this.streamManager.getRemoteStreamList()
          .forEach((remoteStream) => {
            if (remoteStream.getID() !== currentStreamId) {
              if (remoteStream.getAttributes().type === DATA.BROADCAST) {
                this.handleStreamSubscription(remoteStream);
              }
            }
          });
      } else {
        if (this.stateBuffer.dataBroadcastStreamStatus !== status.CONNECTED) {
          return; // subscribe remote streams when our dataBroadcastStream is connected.
        }

        const userConnectionState = this.stateBuffer.connectionTable[user.userId];
        if (!userConnectionState) {
          this.updateState({
            connectionTable: {
              [user.userId]: { $set: {} },
            },
          });
        }

        const sessionConnectionState =
          this.stateBuffer.connectionTable[user.userId][attributes.sessionId];

        if (sessionConnectionState) {
          // need to know if this were to happen
          // either stream got published again somehow or sessionId collision
          console.error(
            'another broadcast stream from existing session',
            attributes,
            this.stateBuffer,
          );
          return;
        }

        this.updateState({
          connectionTable: {
            [user.userId]: {
              [attributes.sessionId]: {
                $set: {
                  broadcastRecieve: status.INITIALIZING,
                  p2pSend: status.DISCONNECTED,
                  p2pRecieve: status.DISCONNECTED,
                },
              },
            },
          },
        });
        this.setIncomingStreamListners(stream);
        this.erizoRoom.subscribe(stream);
      }
    };

    const subscribeP2PDataStream = () => {
      if (this.streamManager.isLocalStream(stream)) return;
      if (this.stateBuffer.dataBroadcastStreamStatus !== status.CONNECTED) return;
      const { recepientUserId, recepientSessionId } = attributes;
      if (recepientUserId !== this.props.roomUserId || recepientSessionId !== this.sessionId) {
        return;
      }
      const userConnectionState = this.stateBuffer.connectionTable[user.userId];
      if (!userConnectionState) {
        console.error('user should have been in connection table');
        return;
      }
      const sessionConnectionState = userConnectionState[attributes.sessionId];
      if (!sessionConnectionState) {
        console.error('could not find user session in conn. table');
        return;
      }
      console.log(sessionConnectionState);
      const { broadcastRecieve, p2pRecieve } = sessionConnectionState;
      if (p2pRecieve !== status.DISCONNECTED) {
        console.error('unexpected yo!');
        return;
      }
      if (broadcastRecieve !== status.CONNECTED) return;

      this.updateState({
        connectionTable: {
          [user.userId]: {
            [attributes.sessionId]: {
              p2pRecieve: { $set: status.INITIALIZING },
            },
          },
        },
      });
      this.setIncomingStreamListners(stream);
      this.erizoRoom.subscribe(stream);
    };

    const subscribeMediaStream = () => {
      const streamId = stream.getID();
      // just a check If I run into this later
      if (this.subscribedMediaStreams[streamId]) { // stream already subscribed
        throw new Meteor.Error('over here!');
      }
      const isLocal = this.streamManager.isLocalStream(stream);
      let streamSrc = '';
      if (isLocal) {
        if (attributes.type === PRIMARY_MEDIA_STREAM) {
          streamSrc = URL.createObjectURL(this.primaryMediaStream.stream);
          this.updateState({
            primaryMediaStream: { $set: status.CONNECTED },
          });
          this.addSpeechTracker(this.primaryMediaStream);
        }
        console.info('adding local media stream');
      } else {
        this.setIncomingStreamListners(stream);
        this.erizoRoom.subscribe(stream);
      }

      this.props.updateMediaStreams({
        [streamId]: {
          $set: {
            userId: user.userId,
            streamId,
            local: isLocal,
            // connected when stream subscription is successfull
            status: isLocal ? status.CONNECTED : status.TRYING_TO_CONNECT,
            audio: stream.hasAudio(),
            video: stream.hasVideo(),
            screen: !!attributes.screenshare,
            streamSrc,
            errorReason: '',
            warningReason: '',
          },
        },
      });
      if (isLocal && stream.hasVideo()) {
        this.incrementVideoStreamCount();
      }
    };

    switch (attributes.type) {
      case DATA.BROADCAST : subscribeDataBroadcastStream();
        break;
      case DATA.P2P: subscribeP2PDataStream();
        break;
      case MEDIA_STREAM:
      case PRIMARY_MEDIA_STREAM: subscribeMediaStream();
        break;
      default: console.error('unexpected stream type');
    }
  }


  handleStreamSubscriptionSucess(stream) {
    const attributes = stream.getAttributes();
    const user = _.find(this.props.roomInfo.participants, { userId: attributes.userId });
    const { DATA, PRIMARY_MEDIA_STREAM, MEDIA_STREAM } = streamTypes;

    const notifySuccessfullSubscription = (broadcast = false, to) => {
      this.roomAPI.sendMessage({
        type: messageType.ROOM_MESSAGE,
        to,
        broadcast,
        content: {
          type: roomMessageTypes.STREAM_SUBSCRIBE_SUCCESS,
          content: {
            streamId: stream.getID(),
            publisherUserId: user.userId,
            publisherSessionId: attributes.sessionId,
          },
        },
      });
    };

    const handleDataBroadcastStreamSubscriptionSuccess = () => {
      this.subscribedDataStreams[stream.getID()] = stream;
      const p2pStream = Erizo.Stream({
        data: true,
        attributes: {
          userId: this.props.roomUserId,
          sessionId: this.sessionId,
          recepientUserId: user.userId,
          recepientSessionId: attributes.sessionId,
          type: streamTypes.DATA.P2P,
        },
      });
      this.updateState({
        connectionTable: {
          [user.userId]: {
            [attributes.sessionId]: {
              p2pSend: { $set: status.INITIALIZING },
            },
          },
        },
      });
      notifySuccessfullSubscription(true); // use broadcast.
      // todo setup listners for failure etc.
      this.erizoRoom.publish(p2pStream);
      // this.connectUser(user);
    };

    const handleP2PDataStreamSubscriptionSuccess = () => {
      this.subscribedDataStreams[stream.getID()] = stream;
      this.updateState({
        connectionTable: {
          [user.userId]: {
            [attributes.sessionId]: {
              p2pRecieve: { $set: status.CONNECTED },
            },
          },
        },
      });
      notifySuccessfullSubscription(true);
    };

    const handleMediaSubscriptionSuccess = () => {
      const streamSrc = URL.createObjectURL(stream.stream);
      this.props.updateMediaStreams({
        [stream.getID()]: {
          status: { $set: status.CONNECTED },
          streamSrc: { $set: streamSrc },
        },
      });
      this.subscribedMediaStreams[stream.getID()] = stream;
      if (stream.hasVideo()) this.incrementVideoStreamCount();
    };

    switch (attributes.type) {
      case DATA.BROADCAST: handleDataBroadcastStreamSubscriptionSuccess();
        break;
      case DATA.P2P: handleP2PDataStreamSubscriptionSuccess();
        break;
      case PRIMARY_MEDIA_STREAM:
      case MEDIA_STREAM:
        handleMediaSubscriptionSuccess();
        break;
      default: console.error('unexpected stream type');
    }
  }

  setIncomingStreamListners(stream) {
    const attributes = stream.getAttributes();
    const { DATA, PRIMARY_MEDIA_STREAM } = streamTypes;
    switch (attributes.type) {
      case DATA.BROADCAST :
        // set listners for data
        stream.addEventListener('stream-data', (streamEvent) => {
          this.messenger.recieve(streamEvent.msg);
        });
        break;
      case DATA.P2P:
        break;
      case PRIMARY_MEDIA_STREAM:
        break;
      default: console.error('unexpected stream type');
    }
  }

  handleStreamRemoval(stream) {
    if (this.unmountInProgress) return;

    const attributes = stream.getAttributes();
    const isLocal = this.streamManager.isLocalStream(stream);
    const user = this.roomAPI.getUserInfo(attributes.userId);
    const { DATA, PRIMARY_MEDIA_STREAM } = streamTypes;

    if (isLocal) {
      console.warn('need to handle this case when I give that option to the user.');
      return;
    }

    switch (attributes.type) {
      case DATA.BROADCAST:
        // remove stream from subscribed streams
        delete this.subscribedDataStreams[stream.getID()];
        this.updateState({
          connectionTable: {
            [user.userId]: {
              $unset: [attributes.sessionId],
            },
          },
        });
        // this.disconnectUser(user);
        break;
      case DATA.P2P: delete this.subscribedDataStreams[stream.getID()];
        break;
      case PRIMARY_MEDIA_STREAM:
        if (this.props.mediaStreams[stream.getID()].video) this.decrementVideoStreamCount();
        this.props.updateMediaStreams({
          $unset: [stream.getID()],
        });
        this.removeSpeechTracker(stream);
        this.subscribedMediaStreams[stream.getID()] = null;
        break;
      default: console.error('unexpected stream type');
    }

    if (this.streamManager.isLocalStream(stream)) {
      console.info('local stream removed');
      return;
    }
  }

  connectUser(user) {
    // adds user to connectedUsers list in state, increments sessionCount if already there.
    const connectedUser = _.find(
      this.stateBuffer.connectedUsers,
      { userId: user.userId }
    );

    if (connectedUser) {
      const connectedUserIndex = _.findIndex(
        this.stateBuffer.connectedUsers,
        { userId: connectedUser.userId }
      );
      if (connectedUserIndex === -1) {
        throw new Meteor.Error("this shouldn't happen, but just in case");
      }

      const updatedUser = update(
        connectedUser,
        {
          sessionCount: { $set: connectedUser.sessionCount + 1 },
        }
      );
      this.updateState({
        connectedUsers: { $splice: [[connectedUserIndex, 1, updatedUser]] },
      });
      console.info('incremented session', updatedUser);
    } else {
      this.updateState({
        connectedUsers: { $push: [{ ...user, sessionCount: 1 }] },
      });
      this.activityListener.dispatch(roomActivities.USER_JOINED, user);
    }
  }

  // decrements sessionCount for user. removing from connectUsers if reaches 0.
  disconnectUser(user) {
    const connectedUserIndex = _.findIndex(
      this.stateBuffer.connectedUsers,
      { userId: user.userId }
    );
    if (connectedUserIndex === -1) {
      throw new Meteor.Error('User does not seem to be connected');
    }

    const connectedUser = this.stateBuffer.connectedUsers[connectedUserIndex];
    if (connectedUser.sessionCount > 1) {
      const updatedUser = update(
        connectedUser,
        {
          sessionCount: { $set: connectedUser.sessionCount - 1 },
        }
      );

      this.updateState({
        connectedUsers: { $splice: [[connectedUserIndex, 1, updatedUser]] },
      });
      console.info('decremented uses sessions', updatedUser);
    } else {
      this.updateState({
        connectedUsers: {
          $splice: [[connectedUserIndex, 1]],
        },
      });
      this.activityListener.dispatch(roomActivities.USER_LEFT, user);
    }
  }

  messageHandler(message) {
    const { SPEECH, STREAM_SUBSCRIBE_SUCCESS } = roomMessageTypes;
    const roomMessage = message.content;
    const handleSpeechMessage = () => {
      const eventDetail = roomMessage.content;
      const streamId = eventDetail.streamId;
      switch (eventDetail.action) {
        case SPEAKING:
          if (this.props.mediaStreams[streamId]) {
            this.props.streamSpeaking(streamId);
          }
          break;
        case SPEAKING_STOPPED:
          if (this.props.mediaStreams[streamId]) {
            this.props.streamSpeakingStopped(streamId);
          }
          break;
        default: console.error('unrecognised speech status');
      }
    };

    const handleSuccessfulSubscriptionFromRemotePeer = () => {
      const { from, sessionId } = message;
      const eventDetail = roomMessage.content;
      const { publisherUserId, publisherSessionId, streamId } = eventDetail;
      const acknowledgeBroadcastSubscription = () => {
        this.updateState({
          connectionTable: {
            [from]: {
              [sessionId]: {
                broadcastRecieve: { $set: status.CONNECTED },
              },
            },
          },
        });
        const p2pStreams = this.streamManager.getRemoteStreamList()
          .filter((stream) => {
            const attributes = stream.getAttributes();
            return (
              attributes.recepientUserId === this.props.roomUserId &&
              attributes.recepientSessionId === this.sessionId &&
              attributes.type === streamTypes.DATA.P2P &&
              !this.subscribedDataStreams[stream.getID()]
            );
          });
        p2pStreams.forEach(stream => this.handleStreamSubscription(stream));
      };

      const acknowledgeP2PDataStreamSubscriptionSuccess = () => {
        this.updateState({
          connectionTable: {
            [from]: {
              [sessionId]: {
                p2pSend: { $set: status.CONNECTED },
              },
            },
          },
        });
      };

      if (publisherUserId === this.props.roomUserId && publisherSessionId === this.sessionId) {
        const stream = this.streamManager.getLocalStreamById(streamId);
        if (!stream) {
          console.error('cannot ack subscription because the local stream was not found', stream);
        }
        const { DATA } = streamTypes;
        switch (stream.getAttributes().type) {
          case DATA.BROADCAST: acknowledgeBroadcastSubscription();
            break;
          case DATA.P2P: acknowledgeP2PDataStreamSubscriptionSuccess();
            break;
          default: console.error('unexpected stream type');
        }
      }
    };
    switch (roomMessage.type) {
      case SPEECH: handleSpeechMessage();
        break;
      case STREAM_SUBSCRIBE_SUCCESS: handleSuccessfulSubscriptionFromRemotePeer();
        break;
      default: console.error('unrecognised room message');
    }
  }

  // to be used with media streams
  // only use for local streams and broadcast the speech events over data stream.
  addSpeechTracker(stream) {
    if (!stream.hasAudio()) console.error('stream has no audio');
    const tracker = hark(stream.stream); // the browser mediaStream object
    tracker.on('speaking', () => {
      this.props.streamSpeaking(stream.getID());
      this.roomAPI.sendMessage({
        broadcast: true,
        type: messageType.ROOM_MESSAGE,
        content: {
          type: roomMessageTypes.SPEECH,
          content: {
            action: SPEAKING,
            streamId: stream.getID(),
          },
        },
      });
    });

    tracker.on('stopped_speaking', () => {
      this.props.streamSpeakingStopped(stream.getID());
      this.roomAPI.sendMessage({
        broadcast: true,
        type: messageType.ROOM_MESSAGE,
        content: {
          type: roomMessageTypes.SPEECH,
          content: {
            action: SPEAKING_STOPPED,
            streamId: stream.getID(),
          },
        },
      });
    });
    this.speechTrackers[stream.getID()] = tracker;
  }

  removeSpeechTracker(stream) {
    const speechTracker = this.speechTrackers[stream.getID()];
    if (speechTracker) speechTracker.stop();
  }

  onWindowResize(event) {
    const { innerHeight, innerWidth } = event.target.window;
    this.updateState({
      uiSize: { $set: this.calculateUISize() },
      roomWidth: { $set: innerWidth },
      roomHeight: { $set: innerHeight },
    });
  }

  componentWillMount() {
    window.addEventListener('resize', this.onWindowResize);
  }

  componentDidMount() {
    // store body bg color and then change it.
    this.tryToConnect();
    this.originialBodyBackground = document.body.style.background;
    document.body.style.backgroundColor = '#2e3136';
  }

  componentWillUnmount() {
    this.unmountInProgress = true;
    if (this.primaryMediaStream) {
      this.removeSpeechTracker(this.primaryMediaStream);
      this.primaryMediaStream.stop();
    }
    this.erizoRoom.disconnect();
    window.removeEventListener('resize', this.onWindowResize);

    // restore original body bg color
    document.body.style.backgroundColor = this.originialBodyBackground;
  }

  incrementVideoStreamCount() {
    this.updateState({ videoStreamCount: { $set: this.stateBuffer.videoStreamCount + 1 } });
  }

  decrementVideoStreamCount() {
    this.updateState({ videoStreamCount: { $set: this.stateBuffer.videoStreamCount - 1 } });
  }

  determineStreamContainerSize() {
    const { mediaStreams } = this.props;
    if (!mediaStreams) return uiConfig.COMPACT;
    const atleastOneVideoStream = Object.keys(mediaStreams)
        .map(streamId => mediaStreams[streamId])
        .some(stream => stream.video && (stream.status !== status.TRYING_TO_CONNECT));
    if (atleastOneVideoStream) return uiConfig.MEDIUM;

    return uiConfig.COMPACT;
  }

  setCustomStreamContainerSize(size) {
    this.updateState({
      customStreamContainerSize: {
        $set: size ? uiConfig[size] : false,
      },
    });
  }

  render() {
    const { uiSize, customStreamContainerSize } = this.state;
    const streamContainerSize = customStreamContainerSize || this.determineStreamContainerSize();
    return (
      <div className='room page'>
        <StreamsContainer
          uiSize={uiSize}
          roomAPI={this.roomAPI}
          streamContainerSize={streamContainerSize}
          roomInfo={this.props.roomInfo}
          connectedUsers={this.state.connectedUsers}/>
        <Spotlight
          roomInfo={this.props.roomInfo}
          connectedUsers={this.state.connectedUsers}
          roomAPI={this.roomAPI}
          dispatchRoomActivity={this.activityListener.dispatch}
          uiSize={uiSize}
          streamContainerSize={streamContainerSize}
          setCustomStreamContainerSize={this.setCustomStreamContainerSize}/>
      </div>
    );
  }
}

Room.propTypes = {
  roomUserId: React.PropTypes.string.isRequired,
  roomInfo: React.PropTypes.object.isRequired,
  joinRoom: React.PropTypes.func.isRequired,
  mediaStreams: React.PropTypes.object.isRequired,
  resetMediaStreams: React.PropTypes.func.isRequired,
  updateMediaStreams: React.PropTypes.func.isRequired,
  streamSpeaking: React.PropTypes.func.isRequired,
  streamSpeakingStopped: React.PropTypes.func.isRequired,
};


const mapStateToProps = state => ({
  mediaStreams: state.mediaStreams,
  focussedStreamId: state.focussedStreamId,
});


const mapDispatchToProps = dispatch => ({
  updateMediaStreams: (changes) => {
    dispatch({
      type: MEDIASTREAMS_UPDATE,
      payload: {
        changes,
      },
    });
  },
  resetMediaStreams: () => {
    dispatch({
      type: MEDIASTREAMS_RESET,
    });
  },
  streamSpeaking: (streamId) => {
    dispatch({
      type: SPEAKING,
      payload: {
        streamId,
      },
    });
  },
  streamSpeakingStopped: (streamId) => {
    dispatch({
      type: SPEAKING_STOPPED,
      payload: {
        streamId,
      },
    });
  },
});


export default connect(mapStateToProps, mapDispatchToProps)(Room);

