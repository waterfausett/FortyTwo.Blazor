#See https://aka.ms/containerfastmode to understand how Visual Studio uses this Dockerfile to build your images for faster debugging.

FROM mcr.microsoft.com/dotnet/aspnet:6.0 AS base
WORKDIR /app
EXPOSE 80
EXPOSE 443

ARG Auth0_ClientId

ENV Auth0_ClientId ${Auth0_ClientId?notset}

FROM mcr.microsoft.com/dotnet/sdk:6.0 AS build
WORKDIR /src
COPY ["FortyTwo/Server/FortyTwo.Server.csproj", "FortyTwo/Server/"]
COPY ["FortyTwo/Shared/FortyTwo.Shared.csproj", "FortyTwo/Shared/"]
COPY ["FortyTwo.Entity/FortyTwo.Entity.csproj", "FortyTwo.Entity/"]
COPY ["FortyTwo/Client/FortyTwo.Client.csproj", "FortyTwo/Client/"]
RUN dotnet restore "FortyTwo/Server/FortyTwo.Server.csproj"
COPY . .
WORKDIR "/src/FortyTwo/Server"
RUN dotnet build "FortyTwo.Server.csproj" -c Release -o /app/build

FROM build AS publish
RUN dotnet publish "FortyTwo.Server.csproj" -c Release -o /app/publish

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
#ENTRYPOINT ["dotnet", "FortyTwo.Server.dll"]
# heroku uses the following

CMD DATABASE_URL=$DATABASE_URL Auth0_ClientId=$Auth0_ClientId Auth0_Authority=$Auth0_Authority Auth0_ApiAudience=$Auth0_ApiAudience ASPNETCORE_URLS=http://*:$PORT dotnet FortyTwo.Server.dll