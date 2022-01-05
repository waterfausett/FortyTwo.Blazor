using FortyTwo.Server.Exceptions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FortyTwo.Server.Middleware
{
    public static class IApplicationBuilderExtensions
    {
        public static void UseGlobalErrorHandler(this IApplicationBuilder app, bool Development)
        {
            app.UseExceptionHandler(errorApp =>
            {
                errorApp.Run(async context =>
                {
                    var error = context.Features.Get<IExceptionHandlerPathFeature>().Error;
                    var serializerOptions = new JsonSerializerOptions { WriteIndented = false, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

                    context.Response.StatusCode = error switch
                    {
                        NotImplementedException e => StatusCodes.Status501NotImplemented,
                        CustomValidationException e => StatusCodes.Status400BadRequest,
                        BadHttpRequestException { Message: "Request body too large." } => StatusCodes.Status413PayloadTooLarge,
                        _ => StatusCodes.Status500InternalServerError
                    };

                    context.Response.ContentType = "application/json";

                    var problem = new ProblemDetails()
                    {
                        Title = error is CustomValidationException 
                            ? error.Message ?? "BadRequest"
                            : Development
                                ? error.GetType().ToString()
                                : error switch
                                {
                                    NotImplementedException e => "NotImplemented",
                                    _ => "UnhandledException"
                                },
                        Detail = error is CustomValidationException cve
                            ? cve.Details
                            : Development
                                ? error.Message
                                : error switch
                                {
                                    _ => null
                                },
                        Status = context.Response.StatusCode
                    };

                    if (Development)
                    {
                        problem.Extensions.Add("StackTrace", error.StackTrace);

                        if (error.InnerException != null)
                        {
                            string innerException = JsonSerializer.Serialize(error.InnerException, serializerOptions);
                            problem.Extensions.Add("InnerException", innerException);
                        }
                    }

                    string serializedProblemDetails = JsonSerializer.Serialize(problem, serializerOptions);

                    await context.Response.WriteAsync(serializedProblemDetails);
                });
            });
        }
    }
}
