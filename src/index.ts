"use strict";
declare global {
	interface Promise<T> {
		asCallback(callback:(error:Error, ...results:any[]) => void, options?: { spread: boolean }): Promise<T>;
	}
}
Promise.prototype.asCallback = function asCallback(callback, options?) {
	if (typeof callback !== "function") return this;
	return this.then((result: any) => {
		if (Array.isArray(result) && options && options.spread) {
			callback.apply(this, [ null ].concat(result));
		} else {
			callback(null, result);
		}
		return result;
	}).catch((e:Error) => callback(e));
};
import mongodb = require("mongodb");
const MongoClient = mongodb.MongoClient;

function defaultSerializeFunction(session: Session) {
	// Copy each property of the session to a new object
	let obj: any = {};
	let prop: string;

	for (prop in session) {
		if (prop === "cookie") {
			// Convert the cookie instance to an object, if possible
			// This gets rid of the duplicate object under session.cookie.data property
			obj.cookie = session.cookie.toJSON ? session.cookie.toJSON() : session.cookie;
		} else {
			obj[prop] = session[prop];
		}
	}

	return obj;
}

interface TransformFunctions {
	serialize?: (session: Session) => any
	unserialize?: (any: any) => Session
}

interface TransformOptions extends TransformFunctions {
	stringify?: boolean
}

function computeTransformFunctions(options: TransformOptions, defaultStringify: boolean): TransformFunctions {
	if (options.serialize || options.unserialize) {
		return {
			serialize: options.serialize || defaultSerializeFunction,
			unserialize: options.unserialize || (x => x),
		};
	}

	if (options.stringify === false || defaultStringify === false) {
		return {
			serialize: defaultSerializeFunction,
			unserialize: x => x,
		};
	}

	if (options.stringify === true || defaultStringify === true) {
		return {
			serialize: JSON.stringify,
			unserialize: JSON.parse,
		};
	}
}

interface Store extends NodeJS.EventEmitter  {
	connectionFailed(err:Error): void
	handleNewConnectionAsync(db: mongodb.Db): Promise<void>
	setAutoRemoveAsync(): Promise<string | void>
	changeState(newState:string): void
	setCollection(collection: mongodb.Collection): Store
	collectionReady(): Promise<mongodb.Collection>
	computeStorageId(sessionId: string): string

	get(sid: string, callback: () => void): Promise<void>
	set(sid: string, session: Session, callback: (error:Error) => void): void | Promise<void>
	touch(sid: string, session: Session, callback: () => void): void | Promise<void>
	destroy(sid: string, callback: (error: Error) => void): Promise<void>
	length(callback: (error: Error, result: number) => void): Promise<number>
	clear(callback: (error: Error, result: any) => void): Promise<any>
	close(): void
}

interface StoreConstructor {
	new(value?: any): Store
}

interface Connect {
	Store?: StoreConstructor
	MemoryStore?: StoreConstructor
	session?: Connect
}

interface Session {
	lastModified?: Date
	cookie?: { expires?: boolean, toJSON?: () => string }
	[key: string]:any
}

interface SessionStorage {
	cookie: any
	lastModified: number    
}

interface Options extends TransformOptions {
	fallbackMemory?: boolean
	ttl?: number
	collection?: string
	autoRemove?: string
	autoRemoveInterval?: number
	url?: string
	mongoOptions?: any
	mongooseConnection?: any
	db?: any
	dbPromise?: Promise<mongodb.Db>
	transformId?: (s:string) => string
	touchAfter?: number
}

module.exports = function connectMongo(connect:Connect) {
	const Store = connect.Store || connect.session.Store;
	const MemoryStore = connect.MemoryStore || connect.session.MemoryStore;

	class MongoStore extends Store {
		private ttl?:number
		private collectionName?:string
		private autoRemove?:string
		private autoRemoveInterval?:number
		private transformFunctions?: TransformFunctions
		private options?: Options

		private db?: mongodb.Db
		private collection?: mongodb.Collection
		private collectionReadyPromise?: Promise<mongodb.Collection>
		private timer?: NodeJS.Timer
		private state?: string

		constructor(options: Options) {
			options = options || {};

			/* Fallback */
			if (options.fallbackMemory && MemoryStore) {
				return new MemoryStore();
			}

			super(options);

			/* Options */
			this.ttl = options.ttl || 1209600; // 14 days
			this.collectionName = options.collection || "sessions";
			this.autoRemove = options.autoRemove || "native";
			this.autoRemoveInterval = options.autoRemoveInterval || 10;
			this.transformFunctions = computeTransformFunctions(options, true);

			this.options = options;

			this.changeState("init");

			const newConnectionCallback = (err: any, db: mongodb.Db) => {
				if (err) {
					this.connectionFailed(err);
				} else {
					this.handleNewConnectionAsync(db);
				}
			};

			if (options.url) {
				// New native connection using url + mongoOptions
				MongoClient.connect(options.url, options.mongoOptions || {}, newConnectionCallback);
			} else if (options.mongooseConnection) {
				// Re-use existing or upcoming mongoose connection
				if (options.mongooseConnection.readyState === 1) {
					this.handleNewConnectionAsync(options.mongooseConnection.db);
				} else {
					options.mongooseConnection.once("open", () => this.handleNewConnectionAsync(options.mongooseConnection.db));
				}
			} else if (options.db && options.db.listCollections) {
				// Re-use existing or upcoming native connection
				if (options.db.openCalled || options.db.openCalled === undefined) { // openCalled is undefined in mongodb@2.x
					this.handleNewConnectionAsync(options.db);
				} else {
					options.db.open(newConnectionCallback);
				}
			} else if (options.dbPromise) {
				options.dbPromise
					.then(db => this.handleNewConnectionAsync(db))
					.catch(err => this.connectionFailed(err));
			} else {
				throw new Error("Connection strategy not found");
			}

			this.changeState("connecting");

		}

		connectionFailed(err:Error): void {
			this.changeState("disconnected");
			throw err;
		}

		handleNewConnectionAsync(db: mongodb.Db): Promise<void> {
			this.db = db;
			return this
				.setCollection(db.collection(this.collectionName))
				.setAutoRemoveAsync()
					.then(() => this.changeState("connected"));
		}

		setAutoRemoveAsync(): Promise<string | void> {
			let removeQuery = { expires: { $lt: new Date() } };
			switch (this.autoRemove) {
			case "native":
				return this.collection.createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
			case "interval":
				this.timer = setInterval(() => this.collection.remove(removeQuery, { w: 0 }), this.autoRemoveInterval * 1000 * 60);
				this.timer.unref();
				return Promise.resolve();
			default:
				return Promise.resolve();
			}
		}

		changeState(newState:string): void {
			if (newState !== this.state) {
				this.state = newState;
				this.emit(newState);
			}
		}

		setCollection(collection: mongodb.Collection): Store {
			if (this.timer) {
				clearInterval(this.timer);
			}
			this.collectionReadyPromise = undefined;
			this.collection = collection;

			return this;
		}

		collectionReady():Promise<mongodb.Collection> {
			let promise = this.collectionReadyPromise;
			if (!promise) {
				promise = new Promise((resolve, reject) => {
					switch (this.state) {
					case "connected":
						resolve(this.collection);
						break;
					case "connecting":
						this.once("connected", () => resolve(this.collection));
						break;
					case "disconnected":
						reject(new Error("Not connected"));
						break;
					}
				});
				this.collectionReadyPromise = promise;
			}
			return promise;
		}

		computeStorageId(sessionId:string): string {
			if (this.options.transformId && typeof this.options.transformId === "function") {
				return this.options.transformId(sessionId);
			} else {
				return sessionId;
			}
		}

		/* Public API */

		get(sid: string, callback: () => void): Promise<void> {
			return this.collectionReady()
				.then(collection => collection.findOne({
					_id: this.computeStorageId(sid),
					$or: [
						{ expires: { $exists: false } },
						{ expires: { $gt: new Date() } },
					],
				}))
				.then(session => {
					if (session) {
						const s = this.transformFunctions.unserialize(session.session);
						if (this.options.touchAfter > 0 && session.lastModified) {
							s.lastModified = session.lastModified;
						}
						this.emit("get", sid);
						return s;
					}
				})
				.asCallback(callback);
		}

		set(sid: string, session: Session, callback: (error:Error) => void): void | Promise<void> {

			// removing the lastModified prop from the session object before update
			if (this.options.touchAfter > 0 && session && session.lastModified) {
				delete session.lastModified;
			}

			let s: { _id: string, session: any, expires?: Date, lastModified?: Date };

			try {
				s = { _id: this.computeStorageId(sid), session: this.transformFunctions.serialize(session) };
			} catch (err) {
				return callback(err);
			}

			if (session && session.cookie && session.cookie.expires) {
				s.expires = new Date(session.cookie.expires);
			} else {
				// If there's no expiration date specified, it is
				// browser-session cookie or there is no cookie at all,
				// as per the connect docs.
				//
				// So we set the expiration to two-weeks from now
				// - as is common practice in the industry (e.g Django) -
				// or the default specified in the options.
				s.expires = new Date(Date.now() + this.ttl * 1000);
			}

			if (this.options.touchAfter > 0) {
				s.lastModified = new Date();
			}

			return this.collectionReady()
				.then(collection => collection.update({ _id: this.computeStorageId(sid) }, s, { upsert: true }))
				.then(writeOpResult => {
					const rawResponse = writeOpResult.result;
					if (rawResponse && rawResponse.upserted) {
						this.emit("create", sid);
					} else {
						this.emit("update", sid);
					}
					this.emit("set", sid);
				})
				.asCallback(callback);
		}

		touch(sid: string, session: Session, callback: () => void): void | Promise<void> {
			const updateFields: { lastModified?: Date, expires?: Date } = {},
				touchAfter = this.options.touchAfter * 1000,
				lastModified = session.lastModified ? session.lastModified.getTime() : 0,
				currentDate = new Date();

			// if the given options has a touchAfter property, check if the
			// current timestamp - lastModified timestamp is bigger than
			// the specified, if it's not, don't touch the session
			if (touchAfter > 0 && lastModified > 0) {

				const timeElapsed = currentDate.getTime() - lastModified;

				if (timeElapsed < touchAfter) {
					return callback();
				} else {
					updateFields.lastModified = currentDate;
				}

			}

			if (session && session.cookie && session.cookie.expires) {
				updateFields.expires = new Date(session.cookie.expires);
			} else {
				updateFields.expires = new Date(Date.now() + this.ttl * 1000);
			}

			return this.collectionReady()
				.then(collection => collection.update({ _id: this.computeStorageId(sid) }, { $set: updateFields }))
				.then(writeOpResult => {
					if (writeOpResult.result.nModified === 0) {
						throw new Error("Unable to find the session to touch");
					} else {
						this.emit("touch", sid);
					}
				})
				.asCallback(callback);
		}

		destroy(sid: string, callback: (error: Error) => void): Promise<void> {
			return this.collectionReady()
				.then(collection => collection.remove({ _id: this.computeStorageId(sid) }))
				.then(() => this.emit("destroy", sid))
				.asCallback(callback);
		}

		length(callback: (error: Error, result: number) => void): Promise<number> {
			return this.collectionReady()
				.then(collection => collection.count({}))
				.asCallback(callback);
		}

		clear(callback: (error: Error, result: any) => void): Promise<any> {
			return this.collectionReady()
				.then(collection => collection.drop())
				.asCallback(callback);
		}

		close(): void {
			if (this.db) {
				this.db.close();
			}
		}
	}

	return MongoStore;
};
