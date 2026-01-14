
export class DomainError extends Error {
    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);
    }
}

export class DuplicateError extends DomainError {
    constructor(message: string) {
        super(message);
    }
}

export class ResourceNotFoundError extends DomainError {
    constructor(message: string) {
        super(message);
    }
}
