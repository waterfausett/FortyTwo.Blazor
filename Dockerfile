FROM mcr.microsoft.com/dotnet/core/aspnet:6.0 AS base
WORKDIR /app
EXPOSE 80
EXPOSE 443

FROM mcr.microsoft.com/dotnet/core/sdk:6.0 AS build
WORKDIR /src
COPY *.sln .
COPY ["FortyTwo/Client/FortyTwo.Client.csproj", "FortyTwo/Client/"]
COPY ["FortyTwo/Server/FortyTwo.Server.csproj", "FortyTwo/Server/"]
COPY ["FortyTwo/Shared/FortyTwo.Shared.csproj", "FortyTwo/Shared/"]

RUN dotnet restore
COPY . .

#testing
#FROM build as testing
#WORKDIR /src/FortyTwo.Tests
#RUN dotnet test

#publish
FROM build AS publish
WORKDIR "/src/FortyTwo/Server"
RUN dotnet publish "FortyTwo.Server.csproj" -c Release -o /app/publish

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
# ENTRYPOINT ["dotnet", "FortyTwo.Server.dll"]
# heroku uses the following
CMD ASPNETCORE_URLS=http://*:$PORT dotnet FortyTwo.Server.dll