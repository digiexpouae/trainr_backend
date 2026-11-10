
 const errorMiddleware = (error, req, res, next) => {
    const status = Number.isInteger(error.status) ? error.status : 500
    // Only errors we chose to send (AppError, 4xx) show their message.
    // Anything else (DB errors, bugs) is logged here and the client gets a generic message.
    const isSafe = status < 500 && error.message
    if (!isSafe) console.error(error)
    return res.status(status).json({
        success: false,
        message: isSafe ? error.message : "Internal server error"
    })

}

 const TryCatch = (func) => {
    return (req, res, next) => {
        return Promise.resolve(func(req, res, next)).catch(next)
    }

}


module.exports = { TryCatch,errorMiddleware };